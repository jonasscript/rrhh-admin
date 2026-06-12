const bcrypt     = require('bcryptjs');
const { z }      = require('zod');
const { query, getClient } = require('../../config/db');
const AppError   = require('../../utils/AppError');
const { success, paginated } = require('../../utils/response');
const { newId }  = require('../../utils/id');

const employeeSchema = z.object({
  firstName:     z.string().min(2),
  lastName:      z.string().min(2),
  cedula:        z.string().min(10).max(13),
  email:         z.string().email(),
  phone:         z.string().optional(),
  address:       z.string().optional(),
  birthDate:     z.string().optional(),
  departmentId:  z.string().optional().nullable(),
  position:      z.string().min(2),
  contractType:  z.enum(['INDEFINIDO', 'PLAZO_FIJO', 'OBRA_CIERTA']).default('INDEFINIDO'),
  startDate:     z.string(),
  endDate:       z.string().optional().nullable(),
  baseSalary:    z.number().positive(),
  iessAffiliate:        z.boolean().default(true),
  bankName:      z.string().optional(),
  bankAccount:   z.string().optional(),
  createUser:    z.boolean().default(false),
});

// GET /employees
const list = async (req, res) => {
  const page   = parseInt(req.query.page  || '1',  10);
  const limit  = parseInt(req.query.limit || '20', 10);
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : null;
  const status = req.query.status || null;
  const dept   = req.query.departmentId || null;

  const conditions = ['1=1'];
  const params     = [];
  let idx = 1;

  if (search) {
    conditions.push(`(e.first_name ILIKE $${idx} OR e.last_name ILIKE $${idx} OR e.cedula ILIKE $${idx} OR e.email ILIKE $${idx})`);
    params.push(search); idx++;
  }
  if (status) { conditions.push(`e.status = $${idx}`); params.push(status); idx++; }
  if (dept)   { conditions.push(`e.department_id = $${idx}`); params.push(dept); idx++; }

  const where = conditions.join(' AND ');

  const countRes = await query(`SELECT COUNT(*) FROM employees e WHERE ${where}`, params);
  const total    = parseInt(countRes.rows[0].count, 10);

  const dataRes  = await query(
    `SELECT e.*, d.name AS department_name
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ${where}
     ORDER BY e.last_name, e.first_name
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  paginated(res, dataRes.rows, total, page, limit);
};

// GET /employees/:id
const getOne = async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, d.name AS department_name
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Empleado no encontrado', 404);
  success(res, rows[0]);
};

// POST /employees
const create = async (req, res) => {
  const data   = employeeSchema.parse(req.body);
  const client = await getClient();

  try {
    await client.query('BEGIN');

    let userId = null;
    if (data.createUser) {
      const hashed = await bcrypt.hash('Temporal123!', 12);
      const userRes = await client.query(
        `INSERT INTO users (id, email, password, role)
         VALUES ($1, $2, $3, 'EMPLEADO') RETURNING id`,
        [newId(), data.email, hashed]
      );
      userId = userRes.rows[0].id;
    }

    const empRes = await client.query(
      `INSERT INTO employees
         (id, user_id, department_id, first_name, last_name, cedula, email, phone, address,
          birth_date, position, contract_type, start_date, end_date, base_salary,
          iess_affiliate, bank_name, bank_account)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        newId(),
        userId, data.departmentId || null,
        data.firstName, data.lastName, data.cedula, data.email,
        data.phone || null, data.address || null, data.birthDate || null,
        data.position, data.contractType,
        data.startDate, data.endDate || null, data.baseSalary,
        data.iessAffiliate,
        data.bankName || null, data.bankAccount || null,
      ]
    );

    // Crear saldo de vacaciones inicial
    await client.query(
      'INSERT INTO vacation_balances (id, employee_id) VALUES ($1, $2)',
      [newId(), empRes.rows[0].id]
    );

    // Crear registro de obligaciones laborales (vacío por defecto)
    await client.query(
      `INSERT INTO employee_labor_obligations (id, employee_id)
       VALUES ($1, $2)
       ON CONFLICT (employee_id) DO NOTHING`,
      [empRes.rows[0].id, empRes.rows[0].id]
    );

    await client.query('COMMIT');
    success(res, empRes.rows[0], 201, 'Empleado creado');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// PUT /employees/:id
const update = async (req, res) => {
  const data = employeeSchema.partial().parse(req.body);

  const fields = [];
  const params = [];
  let idx = 1;

  const map = {
    firstName: 'first_name', lastName: 'last_name', cedula: 'cedula',
    email: 'email', phone: 'phone', address: 'address', birthDate: 'birth_date',
    departmentId: 'department_id', position: 'position', contractType: 'contract_type',
    startDate: 'start_date', endDate: 'end_date', baseSalary: 'base_salary',
    iessAffiliate:       'iess_affiliate',
    bankName: 'bank_name', bankAccount: 'bank_account',
    status: 'status',
  };

  for (const [key, col] of Object.entries(map)) {
    if (data[key] !== undefined) {
      fields.push(`${col} = $${idx}`);
      params.push(data[key]);
      idx++;
    }
  }

  if (!fields.length) throw new AppError('Sin campos para actualizar', 400);

  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE employees SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  if (!rows[0]) throw new AppError('Empleado no encontrado', 404);
  success(res, rows[0]);
};

// DELETE /employees/:id
const remove = async (req, res) => {
  const { rows } = await query(
    `UPDATE employees SET status = 'INACTIVE' WHERE id = $1 RETURNING id`,
    [req.params.id]
  );
  if (!rows[0]) throw new AppError('Empleado no encontrado', 404);
  success(res, null, 200, 'Empleado desactivado');
};

module.exports = { list, getOne, create, update, remove };
