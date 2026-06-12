const { Router } = require('express');
const ctrl = require('./obligation-catalog.controller');
const { authenticate, authorize } = require('../../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

router.get('/',     ctrl.listCatalog);
router.post('/',    authorize('ADMIN'), ctrl.createObligation);
router.put('/:id',  authorize('ADMIN'), ctrl.updateObligation);
router.delete('/:id', authorize('ADMIN'), ctrl.deactivateObligation);

module.exports = router;
