# Servicio OCR de Comprobantes de Pago

Servicio REST API que lee comprobantes de pago (transferencias bancarias y depósitos) utilizando EasyOCR y devuelve datos estructurados. La autenticación usa el flujo **OAuth 2 – Client Credentials**.

---

## Características

- Carga de imágenes de comprobantes (JPG, PNG) o PDFs
- Extracción de texto con EasyOCR (español e inglés por defecto)
- Lectura de estados de movimientos bancarios en PDF, sin depender de Poppler
- Extrae: monto, moneda, fecha, referencia, banco, cuentas origen/destino, remitente/destinatario
- Autenticación OAuth 2 Client Credentials (tokens JWT Bearer)
- FastAPI con documentación Swagger automática en `/docs`

---

## Inicio rápido (local)

```bash
# 1. Copiar y editar el archivo de entorno
cp .env.example .env

# 2. Crear un entorno virtual
python3 -m venv .venv
source .venv/bin/activate

# 3. Instalar dependencias
pip install -r requirements.txt

# 4. Iniciar el servidor
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

Abre <http://localhost:8000/docs> para la documentación interactiva de la API.

---

## Referencia de la API

### 1. Obtener token — `POST /auth/token`

```bash
curl -X POST http://localhost:8000/auth/token \
  -F "grant_type=client_credentials" \
  -F "client_id=backend-client" \
  -F "client_secret=super-secret-change-in-production"
```

Respuesta:

```json
{
  "access_token": "<jwt>",
  "token_type": "bearer",
  "expires_in": 3600
}
```

### 2. Escanear un comprobante — `POST /ocr/scan`

```bash
curl -X POST http://localhost:8000/ocr/scan \
  -H "Authorization: Bearer <jwt>" \
  -F "file=@comprobante.jpg"
```

Respuesta:

```json
{
  "success": true,
  "filename": "comprobante.jpg",
  "extracted_data": {
    "raw_text": "...",
    "payment_type": "transfer",
    "amount": "5,000.00",
    "currency": "MXN",
    "date": "01/04/2026",
    "reference_number": "ABC123456",
    "origin_account": "****1234",
    "destination_account": "012345678901234567",
    "bank": "BBVA",
    "sender_name": "JUAN PÉREZ",
    "receiver_name": "EMPRESA SA DE CV",
    "confidence_score": 0.8742
  }
}
```

### 3. Verificación de estado — `GET /health`

```bash
curl http://localhost:8000/health
```

### 4. Movimientos bancarios — `POST /ocr/movements/scan`

Endpoint público para el backend. Extrae todas las filas de ingreso (`+`) del
PDF de movimientos y devuelve los campos mapeados `payment_date`, `sign`,
`amount` y `description`.

```bash
curl -X POST http://localhost:8000/ocr/movements/scan \
  -F "file=@Movimientos.pdf"
```

---

## Variables de entorno

| Variable | Valor por defecto | Descripción |
|---|---|---|
| `SECRET_KEY` | *(aleatorio)* | Clave de firma JWT — **cambiar en producción** |
| `ALGORITHM` | `HS256` | Algoritmo JWT |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Duración del token |
| `OAUTH_CLIENTS` | `backend-client:...` | Pares `client_id:secret` separados por comas |
| `OCR_LANGUAGES` | `es,en` | Códigos de idioma para EasyOCR |
| `OCR_GPU` | `false` | Activar aceleración por GPU |
| `MAX_FILE_SIZE_MB` | `10` | Límite de tamaño de archivo para carga |

---

## Integración con el backend Node.js

```js
// 1. Obtener token (cachear y renovar antes de que expire)
const { data: tokenData } = await axios.post(
  'http://localhost:8000/auth/token',
  new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.OCR_CLIENT_ID,
    client_secret: process.env.OCR_CLIENT_SECRET,
  }),
);

// 2. Escanear un comprobante
const form = new FormData();
form.append('file', fileBuffer, { filename: 'comprobante.jpg', contentType: 'image/jpeg' });

const { data } = await axios.post('http://localhost:8000/ocr/scan', form, {
  headers: {
    ...form.getHeaders(),
    Authorization: `Bearer ${tokenData.access_token}`,
  },
});

console.log(data.extracted_data);
```
