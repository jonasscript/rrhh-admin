require('dotenv').config();

const crypto = require('crypto');
const http = require('http');

const clientId = process.env.EMAIL_OAUTH2_CLIENT_ID;
const clientSecret = process.env.EMAIL_OAUTH2_CLIENT_SECRET;
const tenant = process.env.EMAIL_OAUTH2_TENANT || 'consumers';
const redirectUri = process.env.EMAIL_OAUTH2_REDIRECT_URI || 'http://localhost:3002/outlook-oauth2/callback';
const scope = process.env.EMAIL_OAUTH2_SCOPE || 'offline_access https://graph.microsoft.com/Mail.Send';

if (!clientId || !clientSecret) {
  console.error('Faltan EMAIL_OAUTH2_CLIENT_ID o EMAIL_OAUTH2_CLIENT_SECRET en el archivo .env.');
  process.exit(1);
}

let redirect;
try {
  redirect = new URL(redirectUri);
} catch (_) {
  console.error('EMAIL_OAUTH2_REDIRECT_URI no es una URL válida.');
  process.exit(1);
}

if (redirect.protocol !== 'http:' || redirect.hostname !== 'localhost' || !redirect.port) {
  console.error('EMAIL_OAUTH2_REDIRECT_URI debe ser una URL local HTTP con puerto, por ejemplo http://localhost:3002/outlook-oauth2/callback');
  process.exit(1);
}

const state = crypto.randomBytes(24).toString('hex');
const authorizeUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
authorizeUrl.searchParams.set('client_id', clientId);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('redirect_uri', redirectUri);
authorizeUrl.searchParams.set('response_mode', 'query');
authorizeUrl.searchParams.set('scope', scope);
authorizeUrl.searchParams.set('state', state);
authorizeUrl.searchParams.set('prompt', 'consent');

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', redirectUri);
  if (requestUrl.pathname !== redirect.pathname) {
    res.writeHead(404).end('Ruta no encontrada.');
    return;
  }

  if (requestUrl.searchParams.get('state') !== state || requestUrl.searchParams.get('error')) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>No se pudo autorizar Outlook.</h2><p>Revisa la terminal para ver el detalle.</p>');
    console.error('Autorización rechazada:', requestUrl.searchParams.get('error_description') || 'state inválido');
    server.close();
    return;
  }

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: requestUrl.searchParams.get('code') || '',
      redirect_uri: redirectUri,
      scope,
    });
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    );
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.refresh_token) {
      throw new Error(token.error_description || 'Microsoft no devolvió un refresh token.');
    }

    console.log('\nAgrega esta línea a backend/.env (no compartas este valor):\n');
    console.log(`EMAIL_OAUTH2_REFRESH_TOKEN=${token.refresh_token}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Autorización completada.</h2><p>Vuelve a la terminal y copia el refresh token a tu archivo .env.</p>');
  } catch (err) {
    console.error('No se pudo intercambiar el código OAuth2:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Error al obtener el token.</h2><p>Revisa la terminal.</p>');
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port), 'localhost', () => {
  console.log('\n1. Registra exactamente esta URL como Redirect URI de tipo Web en Microsoft Entra:');
  console.log(`   ${redirectUri}`);
  console.log('\n2. Abre esta URL en el navegador e inicia sesión con el correo Outlook personal:');
  console.log(`\n${authorizeUrl.toString()}\n`);
});
