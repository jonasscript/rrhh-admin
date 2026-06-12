const { Router } = require('express');
const ctrl = require('./labor-obligations.controller');
const { authenticate, authorize } = require('../../middleware/auth.middleware');

const router = Router({ mergeParams: true }); // mergeParams to access :id from parent

router.use(authenticate);

router.get('/',  ctrl.getByEmployee);
router.put('/',  authorize('ADMIN', 'HR'), ctrl.upsert);

module.exports = router;
