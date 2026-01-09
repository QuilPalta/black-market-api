const { Pool } = require('pg');
require('dotenv').config(); // Asegúrate de tener dotenv instalado en el backend

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // <--- Esto es clave para producción
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};