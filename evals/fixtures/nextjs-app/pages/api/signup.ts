import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const { email, password } = req.body ?? {};
  // TODO: validate
  res.status(201).json({ email, created: true, passwordLength: String(password).length });
}
