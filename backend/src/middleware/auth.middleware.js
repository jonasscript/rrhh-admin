const jwt      = require('jsonwebtoken');
const config   = require('../config/config');
const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const authenticate = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('No autenticado', 401));
  }

  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(new AppError('Token inválido o expirado', 401));
  }

  const { rows } = await query(
    'SELECT id, email, role, is_active FROM users WHERE id = $1',
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    return next(new AppError('Usuario no encontrado o inactivo', 401));
  }

  req.user = user;
  next();
};

const authorize = (...roles) =>
  (req, _res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new AppError('No tienes permisos para esta acción', 403));
    }
    next();
  };

module.exports = { authenticate, authorize };
