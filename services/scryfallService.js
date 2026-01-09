const axios = require('axios');

const SCRYFALL_API_URL = 'https://api.scryfall.com';

const scryfallService = {

    /**
     * Busca cartas por nombre (Para el buscador manual).
     */
    searchCards: async (query) => {
        try {
            // Manejo especial para búsqueda directa por ID (ej: "drc:58")
            // Si el query tiene formato "set:code cn:number", usamos la búsqueda exacta de Scryfall
            const response = await axios.get(`${SCRYFALL_API_URL}/cards/search`, {
                params: {
                    q: query,
                    unique: 'prints', 
                    order: 'released'
                }
            });

            return response.data.data.map(card => ({
                scryfall_id: card.id,
                name: card.name,
                set_name: card.set_name,
                set_code: card.set,
                collector_number: card.collector_number,
                rarity: card.rarity,
                image_url: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || '',
                price_usd: card.prices.usd || card.prices.usd_foil || '0.00'
            }));

        } catch (error) {
            // Scryfall devuelve 404 si no encuentra nada
            if (error.response && error.response.status === 404) {
                return [];
            }
            console.error('Error buscando en Scryfall:', error.message);
            throw error;
        }
    },

    /**
     * NUEVO: Busca un lote de cartas masivo dividiendo en grupos de 75.
     * Soporta cualquier cantidad de cartas (100, 500, etc.)
     */
    getCollection: async (identifiers) => {
        try {
            // 1. Dividimos los identificadores en grupos de 75 (Límite de Scryfall)
            const chunkSize = 75;
            const chunks = [];
            
            for (let i = 0; i < identifiers.length; i += chunkSize) {
                chunks.push(identifiers.slice(i, i + chunkSize));
            }

            console.log(`📡 Procesando ${identifiers.length} cartas en ${chunks.length} peticiones a Scryfall...`);

            // 2. Ejecutamos todas las peticiones en paralelo
            const promises = chunks.map(chunk => 
                axios.post(`${SCRYFALL_API_URL}/cards/collection`, { identifiers: chunk })
                    .then(res => res.data.data) // Solo nos interesa la data de cada lote
                    .catch(err => {
                        console.error("Error en un lote:", err.message);
                        return []; // Si falla un lote, devolvemos array vacío para no romper todo
                    })
            );

            // 3. Esperamos a que todas terminen
            const resultsChunks = await Promise.all(promises);

            // 4. Aplanamos el resultado (Array de Arrays -> Un solo Array gigante)
            const allCards = resultsChunks.flat();

            // 5. Mapeamos al formato de nuestra aplicación
            return allCards.map(card => ({
                scryfall_id: card.id,
                name: card.name,
                set_name: card.set_name,
                set_code: card.set,
                collector_number: card.collector_number,
                rarity: card.rarity,
                image_url: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || '',
                price_usd: card.prices.usd || card.prices.usd_foil || '0.00'
            }));

        } catch (error) {
            console.error('Error crítico en batch Scryfall:', error.message);
            return [];
        }
    }
};

module.exports = scryfallService;