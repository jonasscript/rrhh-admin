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
    delivery: (process.env.EMAIL_DELIVERY || 'SMTP').toUpperCase(),
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER || '',
    authMethod: (process.env.EMAIL_AUTH_METHOD || 'PASSWORD').toUpperCase(),
    oauth2: {
      clientId: process.env.EMAIL_OAUTH2_CLIENT_ID || '',
      clientSecret: process.env.EMAIL_OAUTH2_CLIENT_SECRET || '',
      refreshToken: process.env.EMAIL_OAUTH2_REFRESH_TOKEN || '',
      // "consumers" funciona con cuentas personales @outlook.com/@hotmail.com.
      tenant: process.env.EMAIL_OAUTH2_TENANT || 'consumers',
      tokenUrl: process.env.EMAIL_OAUTH2_TOKEN_URL || '',
      graphScope: process.env.EMAIL_OAUTH2_GRAPH_SCOPE || 'https://graph.microsoft.com/Mail.Send',
    },
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  // El navegador siempre consume este backend; aquí se configura el servicio
  // OCR al que se reenvían los comprobantes.
  ocr: {
    scanUrl: process.env.OCR_SCAN_URL || 'http://localhost:8000/ocr/scan',
    movementsScanUrl: process.env.OCR_MOVEMENTS_SCAN_URL || 'http://localhost:8000/ocr/movements/scan',
  },

  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4200',
};

module.exports = config;
