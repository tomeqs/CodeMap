const express = require('express');
const router = express.Router();

router.delete('/cache', function clear(req, res) {
  res.end();
});

module.exports = router;
