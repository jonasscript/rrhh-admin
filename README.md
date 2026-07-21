# HABBITA

Sistema de administración de Recursos Humanos con módulo de condominio.

## Stack
- **Frontend:** Angular 17 + PrimeNG
- **Backend:** Express.js + TypeScript + Prisma
- **Base de datos:** PostgreSQL

## Módulos
- Autenticación con JWT
- Gestión de Empleados y Departamentos
- Nómina (Ecuador — Costa/Galápagos): IESS, horas extras, décimos, fondos de reserva
- Vacaciones con flujo de aprobación
- Turnos rotativos para guardias
- Comunicados internos con envío automático por email
- Condominio: alícuotas, co-propietarios, mora, comprobantes (Cloudinary)

## Setup rápido

### 1. Backend
```bash
cd backend
cp .env.example .env
# Editar .env con tus credenciales
npm install
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
```

### 2. Frontend
```bash
cd frontend
npm install
ng serve
```

### Acceso inicial
- URL: `http://localhost:4200`
- Email: `admin@rrhh.com`
- Password: `Admin123!`

## Variables de entorno requeridas (backend/.env)
| Variable | Descripción |
|----------|-------------|
| `DATABASE_URL` | Cadena de conexión PostgreSQL |
| `JWT_SECRET` | Clave secreta JWT |
| `EMAIL_HOST` / `EMAIL_PORT` | Servidor SMTP. Outlook.com personal: `smtp-mail.outlook.com`; Microsoft 365: `smtp.office365.com`; puerto `587` |
| `EMAIL_USER` / `EMAIL_FROM` | Correo remitente y nombre visible |
| `EMAIL_DELIVERY` | `GRAPH` para Outlook personal; `SMTP` para SMTP tradicional |
| `EMAIL_AUTH_METHOD` | `OAUTH2` recomendado para Outlook, o `PASSWORD` si tu cuenta permite contraseña SMTP/app password |
| `EMAIL_OAUTH2_CLIENT_ID` / `EMAIL_OAUTH2_CLIENT_SECRET` / `EMAIL_OAUTH2_REFRESH_TOKEN` | Credenciales OAuth2 de Microsoft para envío por Outlook |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

## API Base URL
```
http://localhost:3000/api/v1
```

## Cron Jobs activos
| Job | Frecuencia | Descripción |
|-----|-----------|-------------|
| Anuncios programados | Cada minuto | Envía comunicados en fecha programada |
| Recordatorio alícuotas | Día 5 de cada mes | Email de cobro a propietarios pendientes |
| Actualización mora | Cada lunes | Marca pagos vencidos y acumula mora |
# HABBITA

## Configurar envío con Outlook

1. Registra una aplicación en Microsoft Entra/Azure Portal.
2. En Authentication agrega como Redirect URI de tipo Web:
   `http://localhost:3002/outlook-oauth2/callback`
3. Crea un Client Secret y copia el `Application (client) ID` y el valor del secreto en `backend/.env`.
4. En `backend/.env` usa:
   `EMAIL_DELIVERY=GRAPH` si es Outlook.com/Hotmail personal. Mantén `EMAIL_AUTH_METHOD=OAUTH2`, `EMAIL_USER=tu_correo`, `EMAIL_FROM="HABBITA <tu_correo>"`.
5. Ejecuta `cd backend && npm run email:outlook-oauth`, abre la URL que imprime la terminal, inicia sesión con el correo remitente y copia el `EMAIL_OAUTH2_REFRESH_TOKEN` generado al `.env`.
6. Reinicia el backend y prueba desde Condominio > período > Enviar correos.

Para cuentas Microsoft 365 empresariales con `EMAIL_DELIVERY=SMTP`, confirma además que SMTP AUTH esté habilitado para el buzón remitente y usa tu tenant id/dominio en `EMAIL_OAUTH2_TENANT` en lugar de `consumers`.
