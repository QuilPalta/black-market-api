const express = require('express');
const cors = require('cors');
const db = require('./config/db');
const scryfallService = require('./services/scryfallService');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- RUTAS DE UTILIDAD ---
app.get('/api/health', (req, res) => res.json({ status: 'OK' }));

// 0. LOGIN ADMIN (Seguro)
app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;
    
    // Leemos la contraseña real desde las variables de entorno del servidor
    // Si no existe (ej: local), usamos 'admin123' por defecto
    const serverPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (password === serverPassword) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

// 1. BUSCADOR EXTERNO (Para Admin/Scryfall)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Falta parámetro q' });
    try {
        const results = await scryfallService.searchCards(query);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Error Scryfall' });
    }
});

// 2. BUSCADOR MASIVO (Para Importar ManaBox)
app.post('/api/search-bulk', async (req, res) => {
    const { identifiers } = req.body;
    if (!identifiers || !Array.isArray(identifiers)) return res.status(400).json({ error: 'Formato inválido' });
    try {
        const results = await scryfallService.getCollection(identifiers);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Error procesando lote' });
    }
});

// 3. INVENTARIO INTELIGENTE (FILTROS + BÚSQUEDA + ORDEN)
app.get('/api/inventory', async (req, res) => {
    try {
        // Extraemos los filtros de la URL
        const { 
            q,          // Búsqueda por texto (nombre)
            type,       // SINGLE o SEALED
            category,   // Booster Box, etc.
            color,      // W, U, B... (Asumiremos que guardamos esto o lo filtraremos por nombre si no está en DB)
            rarity,     // Mythic, Rare... (Necesitaríamos guardar rareza en DB, asumiremos que existe o lo ignoramos por ahora)
            min_price, 
            max_price,
            sort        // price_asc, price_desc, newest
        } = req.query;

        let queryText = 'SELECT * FROM inventory WHERE 1=1';
        let queryParams = [];
        let paramIndex = 1;

        // --- Filtros Dinámicos ---
        
        // Tipo (Obligatorio para separar Singles de Sellado)
        if (type) {
            queryText += ` AND type = $${paramIndex}`;
            queryParams.push(type);
            paramIndex++;
        }

        // Búsqueda de Texto (ILIKE es case-insensitive)
        if (q) {
            queryText += ` AND card_name ILIKE $${paramIndex}`;
            queryParams.push(`%${q}%`);
            paramIndex++;
        }

        // Categoría (Para sellado)
        if (category) {
             queryText += ` AND category = $${paramIndex}`;
             queryParams.push(category);
             paramIndex++;
        }

        // Precio
        if (min_price) {
            queryText += ` AND price >= $${paramIndex}`;
            queryParams.push(min_price);
            paramIndex++;
        }
        if (max_price) {
            queryText += ` AND price <= $${paramIndex}`;
            queryParams.push(max_price);
            paramIndex++;
        }

        // --- Ordenamiento ---
        if (sort === 'price_asc') {
            queryText += ' ORDER BY price ASC';
        } else if (sort === 'price_desc') {
            queryText += ' ORDER BY price DESC';
        } else {
            queryText += ' ORDER BY created_at DESC'; // Por defecto: Lo más nuevo
        }

        // Limitamos a 100 resultados por seguridad (Paginación simple)
        queryText += ' LIMIT 100';

        const result = await db.query(queryText, queryParams);
        res.json(result.rows);

    } catch (error) {
        console.error("Error en inventario:", error);
        res.status(500).json({ error: 'DB Error' });
    }
});

// 4. GUARDAR EN INVENTARIO (UNIFICADO)
app.post('/api/inventory', async (req, res) => {
    const { 
        scryfall_id, card_name, set_code, collector_number, 
        price, stock, condition, language, is_foil, image_url,
        type, category 
    } = req.body;

    if (!price || !card_name) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const finalType = type || 'SINGLE';
        const finalScryfallId = scryfall_id || `sealed-${Date.now()}`; 

        // IMPORTANTE: Asegúrate que tu DB tenga todas estas columnas.
        // Si 'rarity' o 'colors' no existen en tu tabla, no intentes filtrarlos en el GET aún.
        const text = `
            INSERT INTO inventory 
            (scryfall_id, card_name, set_code, collector_number, price, stock, condition, language, is_foil, image_url, type, category) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
            RETURNING *
        `;
        
        const values = [
            finalScryfallId, card_name, set_code || 'N/A', collector_number || '0', 
            parseInt(price), parseInt(stock || 1), condition || 'NM', language || 'EN', 
            is_foil || false, image_url, finalType, category || null
        ];

        const result = await db.query(text, values);
        res.status(201).json(result.rows[0]);

    } catch (error) {
        console.error('Error al guardar:', error);
        res.status(500).json({ error: 'Error guardando en BD' });
    }
});

// 6. CREAR PEDIDO (Con validación de stock y transacción)
app.post('/api/orders', async (req, res) => {
    const { customer_name, contact_info, items, total } = req.body;
    
    // Necesitamos un cliente individual para manejar la transacción
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Iniciamos la transacción

        // 1. Validar Stock y Restar Cantidades
        for (const item of items) {
            // Buscamos el stock actual de la carta (bloqueamos la fila para evitar conflictos)
            // Asumimos que 'item.id' es el ID de la base de datos (inventory.id)
            const checkRes = await client.query(
                'SELECT id, card_name, stock FROM inventory WHERE id = $1 FOR UPDATE',
                [item.id]
            );

            if (checkRes.rows.length === 0) {
                throw new Error(`El producto "${item.card_name}" ya no existe.`);
            }

            const product = checkRes.rows[0];

            if (product.stock < item.quantity) {
                throw new Error(`Stock insuficiente para "${product.card_name}". Disponible: ${product.stock}, Pedido: ${item.quantity}`);
            }

            // Restamos el stock
            await client.query(
                'UPDATE inventory SET stock = stock - $1 WHERE id = $2',
                [item.quantity, item.id]
            );
        }

        // 2. Crear la Orden
        const orderResult = await client.query(
            'INSERT INTO orders (customer_name, contact_info, items, total) VALUES ($1, $2, $3, $4) RETURNING *',
            [customer_name, contact_info, JSON.stringify(items), total]
        );

        await client.query('COMMIT'); // Confirmamos los cambios si todo salió bien
        
        res.status(201).json(orderResult.rows[0]);

    } catch (error) {
        await client.query('ROLLBACK'); // Deshacemos todo si hubo error
        console.error("Error creando pedido:", error);
        
        // Devolvemos el mensaje de error específico (ej: "Stock insuficiente...")
        res.status(400).json({ error: error.message });
    } finally {
        client.release(); // Liberamos el cliente
    }
});

// 6. OBTENER PEDIDOS (PARA ADMIN)
app.get('/api/orders', async (req, res) => {
    try {
        // Traemos los pedidos ordenados del más nuevo al más antiguo
        const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error("Error obteniendo pedidos:", error);
        res.status(500).json({ error: "Error al cargar pedidos" });
    }
});

// 7. ACTUALIZAR ESTADO DE PEDIDO
app.patch('/api/orders/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    // Lista blanca de estados permitidos para evitar errores
    const validStatuses = ['PENDING', 'IN_PROGRESS', 'READY', 'COMPLETED', 'REJECTED'];
    
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Estado inválido" });
    }

    try {
        const result = await db.query(
            'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', 
            [status, id]
        );
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Pedido no encontrado" });
        }

        res.json({ success: true, order: result.rows[0] });
    } catch (error) {
        console.error("Error actualizando estado:", error);
        res.status(500).json({ error: "Error de base de datos" });
    }
});

// Solo escuchamos el puerto si estamos en local (no en producción/Vercel)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
}

// Exportamos la app para que Vercel la pueda ejecutar como función serverless
module.exports = app;