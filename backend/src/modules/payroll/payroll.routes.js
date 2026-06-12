const { Router } = require('express');
const ctrl = require('./payroll.controller');
const { authenticate, authorize } = require('../../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

router.get('/periods',                              ctrl.listPeriods);
router.post('/periods',   authorize('ADMIN','HR'), ctrl.createPeriod);
router.get('/periods/:periodId',                    ctrl.getPeriod);
router.get('/periods/:periodId/details',            ctrl.listDetails);
router.post('/periods/:periodId/generate', authorize('ADMIN','HR'), ctrl.generatePayroll);
router.put('/periods/:periodId/details/:employeeId', authorize('ADMIN','HR'), ctrl.updateDetail);
router.post('/periods/:periodId/close',   authorize('ADMIN','HR'), ctrl.closePeriod);
router.get('/details/:detailId/pdf',                ctrl.downloadPdf);

module.exports = router;
