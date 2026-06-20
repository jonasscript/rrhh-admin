const config = require('../config/config');

const errorMiddleware = (err, _req, res, _next) => {
  // Log en desarrollo
  if (config.nodeEnv === 'development') {
    console.error('[ERROR]', err);
  }

  // Errores de validación Zod → 400
  if (err.name === 'ZodError') {
    const message = err.errors[0]?.message || 'Datos inválidos';
    return res.status(400).json({ success: false, message, errors: err.errors });
  }

  // Errores de Postgres
  if (err.code === '23505') {
    return res.status(409).json({ success: false, message: 'Registro duplicado', detail: err.detail });
  }
  if (err.code === '23503') {
    return res.status(409).json({ success: false, message: 'Referencia inválida', detail: err.detail });
  }
  if (err.code === '23514') {
    return res.status(400).json({ success: false, message: 'Valor no permitido por restricción de base de datos', detail: err.detail });
  }

  const statusCode = err.statusCode || 500;
  const message    = err.isOperational ? err.message : 'Error interno del servidor';
  res.status(statusCode).json({ success: false, message });
};

module.exports = { errorMiddleware };

