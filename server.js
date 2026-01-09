const express = require('express');
const cors = require('cors');
// CAMBIO 1: Desestructuramos para tener 'pool' y 'query' disponibles directamente
const { query, pool } = require('./config/db'); 
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
    const serverPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (password === serverPassword) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

// 1. BUSCADOR EXTERNO (Para Admin/Scryfall)
app.get('/api/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Falta parámetro q' });
    try {
        const results = await scryfallService.searchCards(q);
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

// 3. INVENTARIO INTELIGENTE
app.get('/api/inventory', async (req, res) => {
    try {
        const { q, type, category, min_price, max_price, sort } = req.query;

        let queryText = 'SELECT * FROM inventory WHERE 1=1';
        let queryParams = [];
        let paramIndex = 1;

        if (type) {
            queryText += ` AND type = $${paramIndex}`;
            queryParams.push(type);
            paramIndex++;
        }
        if (q) {
            queryText += ` AND card_name ILIKE $${paramIndex}`;
            queryParams.push(`%${q}%`);
            paramIndex++;
        }
        if (category) {
             queryText += ` AND category = $${paramIndex}`;
             queryParams.push(category);
             paramIndex++;
        }
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

        if (sort === 'price_asc') {
            queryText += ' ORDER BY price ASC';
        } else if (sort === 'price_desc') {
            queryText += ' ORDER BY price DESC';
        } else {
            queryText += ' ORDER BY created_at DESC';
        }

        queryText += ' LIMIT 100';

        // CAMBIO 2: Usamos 'query' directo en lugar de 'db.query'
        const result = await query(queryText, queryParams);
        res.json(result.rows);

    } catch (error) {
        console.error("Error en inventario:", error);
        res.status(500).json({ error: 'DB Error' });
    }
});

// 4. GUARDAR EN INVENTARIO
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

        // CAMBIO 2
        const result = await query(text, values);
        res.status(201).json(result.rows[0]);

    } catch (error) {
        console.error('Error al guardar:', error);
        res.status(500).json({ error: 'Error guardando en BD' });
    }
});

// 6. CREAR PEDIDO (Con transacción)
app.post('/api/orders', async (req, res) => {
    const { customer_name, contact_info, items, total } = req.body;
    
    // Ahora 'pool' SÍ existe porque lo importamos arriba
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        for (const item of items) {
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

            await client.query(
                'UPDATE inventory SET stock = stock - $1 WHERE id = $2',
                [item.quantity, item.id]
            );
        }

        const orderResult = await client.query(
            'INSERT INTO orders (customer_name, contact_info, items, total) VALUES ($1, $2, $3, $4) RETURNING *',
            [customer_name, contact_info, JSON.stringify(items), total]
        );

        await client.query('COMMIT');
        res.status(201).json(orderResult.rows[0]);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error creando pedido:", error);
        res.status(400).json({ error: error.message });
    } finally {
        client.release();
    }
});

// 6. OBTENER PEDIDOS
app.get('/api/orders', async (req, res) => {
    try {
        // CAMBIO 2
        const result = await query('SELECT * FROM orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error("Error obteniendo pedidos:", error);
        res.status(500).json({ error: "Error al cargar pedidos" });
    }
});

// 7. ACTUALIZAR ESTADO
app.patch('/api/orders/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    const validStatuses = ['PENDING', 'IN_PROGRESS', 'READY', 'COMPLETED', 'REJECTED'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: "Estado inválido" });

    try {
        // CAMBIO 2
        const result = await query(
            'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', 
            [status, id]
        );
        
        if (result.rowCount === 0) return res.status(404).json({ error: "Pedido no encontrado" });

        res.json({ success: true, order: result.rows[0] });
    } catch (error) {
        console.error("Error actualizando estado:", error);
        res.status(500).json({ error: "Error de base de datos" });
    }
});

// INICIO SERVIDOR (Vercel)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
}

module.exports = app;