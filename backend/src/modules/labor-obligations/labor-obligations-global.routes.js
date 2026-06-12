const { Router } = require('express');
const ctrl = require('./labor-obligations.controller');
const { authenticate, authorize } = require('../../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

// GET /labor-obligations  — lista global de empleados con sus obligaciones
router.get('/', authorize('ADMIN', 'HR'), ctrl.listAll);

// GET /labor-obligations/payment-records  — historial de pagos mensuales
router.get('/payment-records', authorize('ADMIN', 'HR'), ctrl.listPaymentRecords);

module.exports = router;
