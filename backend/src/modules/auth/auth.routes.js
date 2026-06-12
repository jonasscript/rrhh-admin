const { Router } = require('express');
const { login, me, changePassword } = require('./auth.controller');
const { authenticate } = require('../../middleware/auth.middleware');

const router = Router();

router.post('/login',           login);
router.get('/me',               authenticate, me);
router.patch('/change-password', authenticate, changePassword);

module.exports = router;
