const app    = require('./app');
const config = require('./config/config');
const { pool } = require('./config/db');
const { startCronJobs } = require('./jobs/cron.jobs');

const start = async () => {
  // Verificar conexión a la base de datos
/*   try {
    await pool.query('SELECT 1');
    console.log('✓ PostgreSQL conectado');
  } catch (err) {
    console.error('✗ No se pudo conectar a PostgreSQL:', err.message);
    process.exit(1);
  } */

  app.listen(config.port, () => {
    console.log(`✓ Servidor corriendo en http://localhost:${config.port}`);
    console.log(`  Entorno: ${config.nodeEnv}`);
    startCronJobs();
  });
};

start();
