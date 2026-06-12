const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { z }    = require('zod');
const { query } = require('../../config/db');
const config   = require('../../config/config');
const AppError = require('../../utils/AppError');
const { success } = require('../../utils/response');

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword:     z.string().min(8),
});

// POST /auth/login
const login = async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const { rows } = await query(
    'SELECT id, email, password, role, is_active FROM users WHERE email = $1',
    [email]
  );
  const user = rows[0];
  if (!user || !user.is_active) throw new AppError('Credenciales inválidas', 401);

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new AppError('Credenciales inválidas', 401);

  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

  success(res, { token, user: { id: user.id, email: user.email, role: user.role } });
};

// GET /auth/me
const me = async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.role,
            e.first_name, e.last_name, e.photo_url
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE u.id = $1`,
    [req.user.id]
  );
  success(res, rows[0]);
};

// PATCH /auth/change-password
const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  const { rows } = await query('SELECT password FROM users WHERE id = $1', [req.user.id]);
  const valid = await bcrypt.compare(currentPassword, rows[0].password);
  if (!valid) throw new AppError('Contraseña actual incorrecta', 400);

  const hashed = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id]);

  success(res, null, 200, 'Contraseña actualizada');
};

module.exports = { login, me, changePassword };
