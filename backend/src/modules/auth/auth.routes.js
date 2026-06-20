const { Router } = require('express');
const { login, me, refresh, changePassword } = require('./auth.controller');
const { authenticate } = require('../../middleware/auth.middleware');

const router = Router();

router.post('/login',            login);
router.post('/refresh',          refresh);
router.get('/me',                authenticate, me);
router.patch('/change-password', authenticate, changePassword);

module.exports = router;
