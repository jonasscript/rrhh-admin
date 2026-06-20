require('dotenv').config();

// Validar secreto JWT — no permitir el valor default en producción
const jwtSecret = process.env.JWT_SECRET || 'change_this_secret';
if (jwtSecret === 'change_this_secret' && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET debe estar configurado en variables de entorno en producción');
}

const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER || '',
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4200',
};

module.exports = config;
