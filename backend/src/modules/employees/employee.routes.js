const { Router } = require('express');
const ctrl = require('./employee.controller');
const { authenticate, authorize } = require('../../middleware/auth.middleware');
const laborObligationsRoutes = require('../labor-obligations/labor-obligations.routes');

const router = Router();

router.use(authenticate);

router.get('/',     ctrl.list);
router.get('/:id',  ctrl.getOne);
router.post('/',    authorize('ADMIN', 'HR'), ctrl.create);
router.put('/:id',  authorize('ADMIN', 'HR'), ctrl.update);
router.delete('/:id', authorize('ADMIN', 'HR'), ctrl.remove);

// Sub-recurso: obligaciones laborales por empleado
router.use('/:id/labor-obligations', laborObligationsRoutes);

module.exports = router;
