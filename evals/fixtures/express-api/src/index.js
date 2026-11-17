const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const users = new Map(); // id -> { id, email, name }
let nextId = 1;

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/users', (req, res) => res.json([...users.values()]));
app.post('/users', (req, res) => {
  const user = { id: nextId++, ...req.body };
  users.set(user.id, user);
  res.status(201).json(user);
});
app.get('/users/:id', (req, res) => {
  const u = users.get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(u);
});

app.listen(process.env.PORT || 3000, () => console.log('listening'));
