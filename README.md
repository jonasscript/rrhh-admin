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
| `EMAIL_USER` / `EMAIL_PASS` | Credenciales SMTP (Gmail con App Password) |
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
