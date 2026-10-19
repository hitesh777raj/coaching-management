require('dotenv').config();
const express = require('express');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

// Auto-parse PostgreSQL NUMERIC types into JavaScript numbers
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'shape_and_shine_super_secret_key_2026';

// Support payloads for photos and PDF files
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(cors());
app.use(express.static(__dirname));

let activeUsersCount = 5;

// Relaxed 10-Digit Mobile Sanitizer
function sanitizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// PostgreSQL Connection Pool (Supabase Compatible)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') 
    ? false 
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('Unexpected database client error:', err.message);
});

// Initialize Database Tables & Default Seeds Safely
async function initDatabase() {
  try {
    // 1. Users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        standard TEXT DEFAULT '10th Standard (Board)',
        medium TEXT DEFAULT 'English',
        phone TEXT,
        fee_status TEXT DEFAULT 'Pending',
        payment_plan TEXT DEFAULT 'One-Time',
        monthly_fee NUMERIC(10,2) DEFAULT 0.00,
        paid_amount NUMERIC(10,2) DEFAULT 0.00,
        total_fees NUMERIC(10,2) DEFAULT 15000.00,
        role TEXT DEFAULT 'student',
        academic_year TEXT DEFAULT '2026-2027'
      );
    `);

    // 2. Standard Fees
    await pool.query(`
      CREATE TABLE IF NOT EXISTS standard_fees (
        standard TEXT PRIMARY KEY,
        fee_amount NUMERIC(10,2) NOT NULL,
        default_monthly_fee NUMERIC(10,2) DEFAULT 1500.00
      );
    `);

    // 3. Batch Timings
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batch_timings (
        standard TEXT PRIMARY KEY,
        morning_batch TEXT DEFAULT '07:00 AM - 09:30 AM',
        evening_batch TEXT DEFAULT '04:00 PM - 07:00 PM',
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Teachers
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teachers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        experience TEXT NOT NULL,
        qualification TEXT,
        photo_data TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Site Settings
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // 6. Attendance
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, date)
      );
    `);

    // 7. Fee Receipts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fee_receipts (
        id SERIAL PRIMARY KEY,
        receipt_no TEXT UNIQUE NOT NULL,
        student_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        standard TEXT NOT NULL,
        payment_type TEXT DEFAULT 'Full / Installment',
        payment_for_month TEXT DEFAULT '',
        amount_paid NUMERIC(10,2) NOT NULL,
        total_fees NUMERIC(10,2) NOT NULL,
        balance_amount NUMERIC(10,2) NOT NULL,
        payment_mode TEXT DEFAULT 'Cash / Online UPI',
        date TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 8. Messages
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 9. Marks
    await pool.query(`
      CREATE TABLE IF NOT EXISTS marks (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        test_name TEXT,
        subject TEXT,
        score INTEGER,
        total_marks INTEGER DEFAULT 50,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 10. Study Materials
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_materials (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        standard TEXT NOT NULL,
        subject TEXT NOT NULL,
        file_link TEXT,
        file_data TEXT,
        file_name TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 11. Events
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'Notice'
      );
    `);

    // 12. Inquiries
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id SERIAL PRIMARY KEY,
        parent_name TEXT,
        student_name TEXT,
        standard TEXT,
        phone TEXT,
        message TEXT,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 13. Gallery
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gallery (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        image_data TEXT NOT NULL,
        description TEXT,
        date TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 14. Backup: Deleted Students Archive
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deleted_students_archive (
        id SERIAL PRIMARY KEY,
        original_id INTEGER,
        name TEXT,
        email TEXT,
        phone TEXT,
        standard TEXT,
        paid_amount NUMERIC(10,2),
        total_fees NUMERIC(10,2),
        reason TEXT,
        archived_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 15. Backup: Academic Progression History
    await pool.query(`
      CREATE TABLE IF NOT EXISTS academic_progression_history (
        id SERIAL PRIMARY KEY,
        student_id INTEGER,
        student_name TEXT,
        from_standard TEXT,
        to_standard TEXT,
        previous_fee_paid NUMERIC(10,2),
        academic_year TEXT,
        promoted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed Default Fees
    await pool.query(`
      INSERT INTO standard_fees (standard, fee_amount, default_monthly_fee) VALUES
        ('1st Standard', 8000, 800),
        ('2nd Standard', 8000, 800),
        ('3rd Standard', 9000, 900),
        ('4th Standard', 9000, 900),
        ('5th Standard', 10000, 1000),
        ('6th Standard', 11000, 1100),
        ('7th Standard', 12000, 1200),
        ('8th Standard', 13000, 1300),
        ('9th Standard', 15000, 1500),
        ('10th Standard (Board)', 18000, 1800),
        ('11th Science', 25000, 2500),
        ('11th Commerce', 20000, 2000),
        ('12th Science (Board)', 30000, 3000),
        ('12th Commerce (Board)', 24000, 2400)
      ON CONFLICT (standard) DO NOTHING;
    `);

    // Seed Default Batch Timings
    await pool.query(`
      INSERT INTO batch_timings (standard, morning_batch, evening_batch) VALUES
        ('1st Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('2nd Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('3rd Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('4th Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('5th Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('6th Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('7th Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('8th Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('9th Standard', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('10th Standard (Board)', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('11th Science', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('11th Commerce', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('12th Science (Board)', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM'),
        ('12th Commerce (Board)', '07:00 AM - 09:30 AM', '04:00 PM - 07:00 PM')
      ON CONFLICT (standard) DO NOTHING;
    `);

    // Seed Default Site Settings
    await pool.query(`
      INSERT INTO site_settings (key, value) VALUES 
        ('instagram_link', 'https://instagram.com/shapeandshine'),
        ('facebook_link', 'https://facebook.com/shapeandshine'),
        ('whatsapp_number', '919824528709'),
        ('youtube_link', 'https://youtube.com/@shapeandshine')
      ON CONFLICT (key) DO NOTHING;
    `);

    // Seed Default Teachers (if table is empty)
    const tCount = await pool.query('SELECT COUNT(*) as count FROM teachers');
    if (Number(tCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO teachers (name, subject, experience, qualification, photo_data, description) VALUES 
        ('Prof. Rajesh Sharma', 'Physics & Advanced Mathematics', '12+ Years Exp', 'M.Sc (Physics), B.Ed', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=600&q=80', 'Specialist in 10th & 12th Board Science and entrance problem-solving shortcuts.'),
        ('Dr. Meena Patel', 'Chemistry & Biology', '9+ Years Exp', 'Ph.D, M.Sc (Gold Medalist)', 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=600&q=80', 'Dedicated mentor focusing on conceptual clarity, diagrams and practical memory techniques.'),
        ('CA Hitesh Agrawal', 'Accountancy & Statistics', '10+ Years Exp', 'Chartered Accountant, M.Com', 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=600&q=80', 'Guiding 11th & 12th Commerce students with practical account balance sheet masterclasses.')
      `);
    }

    // Seed Master Admin (if not present)
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin@shapeandshine.com').toLowerCase().trim();
    const adminCheck = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (adminCheck.rows.length === 0) {
      const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = bcrypt.hashSync(adminPass, 10);
      await pool.query(`
        INSERT INTO users (name, email, password, standard, medium, phone, fee_status, role)
        VALUES ('Master Administrator', $1, $2, 'Admin', 'All', '09824528709', 'Paid', 'admin')
      `, [adminEmail, hash]);
      console.log('✓ Master Admin account initialized.');
    }

    console.log('✓ PostgreSQL Database tables verified & connected.');
  } catch (err) {
    console.error('Database Init Error:', err.message);
  }
}

// Run DB initialization
initDatabase();

// Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Session expired. Please log in again.' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
}

app.get('/api/ping', (req, res) => {
  const variation = Math.floor(Math.random() * 3) - 1; 
  activeUsersCount = Math.max(3, activeUsersCount + variation);
  res.json({ activeOnline: activeUsersCount });
});

// Registration
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, standard, phone, payment_plan } = req.body;
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const cleanPhone = sanitizePhone(phone);
    const passRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@$!%*#?&]{6,20}$/;

    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Please enter a valid full name.' });
    if (!cleanPhone || cleanPhone.length !== 10) return res.status(400).json({ error: 'Mobile number must be exactly 10 digits long.' });
    if (!email || !emailRegex.test(email.trim())) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!password || !passRegex.test(password)) return res.status(400).json({ error: 'Password must be 6-20 characters long with letters & numbers.' });
    if (!standard) return res.status(400).json({ error: 'Please select a standard.' });

    const feeRes = await pool.query('SELECT fee_amount, default_monthly_fee FROM standard_fees WHERE standard = $1', [standard]);
    const feeRow = feeRes.rows[0];
    const totalFee = feeRow ? Number(feeRow.fee_amount) : 15000;
    const monthlyFee = feeRow ? Number(feeRow.default_monthly_fee) : 1500;
    const plan = payment_plan === 'Monthly' ? 'Monthly' : 'One-Time';
    const hashed = bcrypt.hashSync(password, 10);

    const insertUser = await pool.query(
      `INSERT INTO users (name, email, password, standard, phone, total_fees, monthly_fee, payment_plan, paid_amount, fee_status, academic_year)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0.0, 'Pending', '2026-2027') RETURNING id`,
      [name.trim(), email.trim().toLowerCase(), hashed, standard, cleanPhone, totalFee, monthlyFee, plan]
    );

    const newUserId = insertUser.rows[0].id;
    await pool.query(
      `INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`,
      [newUserId, `Welcome ${name.trim()} to Shape & Shine! Plan: ${plan} (Course Fee: ₹${totalFee.toLocaleString()}). Feel free to ask any query here.`]
    );

    const token = jwt.sign({ id: newUserId, name, email: email.trim().toLowerCase(), role: 'student', standard }, JWT_SECRET);
    res.json({
      message: 'Registration successful!',
      token,
      user: { id: newUserId, name, email, role: 'student', standard, fee_status: 'Pending', paid_amount: 0, total_fees: totalFee, payment_plan: plan, monthly_fee: monthlyFee }
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Email is already registered.' });
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Account not found with this email.' });

    const isValid = bcrypt.compareSync(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Incorrect password.' });

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role, standard: user.standard }, JWT_SECRET);
    res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        standard: user.standard,
        fee_status: user.fee_status,
        paid_amount: Number(user.paid_amount),
        total_fees: Number(user.total_fees),
        payment_plan: user.payment_plan,
        monthly_fee: Number(user.monthly_fee)
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login error. Please try again.' });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

app.get('/api/teachers', async (req, res) => {
  res.json([]);
});

app.get('/api/gallery', async (req, res) => {
  res.json([]);
});

app.get('/api/settings', async (req, res) => {
  res.json({});
});

// Reset Password (Forgot Password)
app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, newPassword, confirmPassword } = req.body;
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const passRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@$!%*#?&]{6,20}$/;

    if (!email || !emailRegex.test(email.trim())) return res.status(400).json({ error: 'Please enter a valid registered email address.' });
    if (!newPassword || !passRegex.test(newPassword)) return res.status(400).json({ error: 'Password must be 6-20 characters long and contain both letters and numbers.' });
    if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New password and confirm password do not match.' });

    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'No account found with this email address.' });

    const hashed = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, user.id]);
    res.json({ message: 'Password reset successfully! You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to update password. Please try again.' });
  }
});

// Admission Inquiry//
app.post('/api/inquiries', async (req, res) => {
  try {
    const { parent_name, student_name, standard, phone, message } = req.body;
    const cleanPhone = sanitizePhone(phone);

    if (!parent_name || !student_name || !cleanPhone || cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'Please enter valid names and a 10-digit mobile number.' });
    }

    await pool.query(
      `INSERT INTO inquiries (parent_name, student_name, standard, phone, message, is_read) VALUES ($1, $2, $3, $4, $5, 0)`,
      [parent_name.trim(), student_name.trim(), standard, cleanPhone, message ? message.trim() : '']
    );
    res.json({ message: 'Enquiry submitted!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record inquiry.' });
  }
});

// Teachers
app.get('/api/teachers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM teachers ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch teachers.' });
  }
});

app.post('/api/admin/teachers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, subject, experience, qualification, photo_data, description } = req.body;
    if (!name || !subject || !experience || !photo_data) {
      return res.status(400).json({ error: 'Teacher name, subject, experience, and photo are required.' });
    }

    await pool.query(
      `INSERT INTO teachers (name, subject, experience, qualification, photo_data, description) VALUES ($1, $2, $3, $4, $5, $6)`,
      [name.trim(), subject.trim(), experience.trim(), qualification ? qualification.trim() : '', photo_data, description ? description.trim() : '']
    );
    res.json({ message: 'Teacher profile added successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add teacher.' });
  }
});

app.put('/api/admin/teachers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, subject, experience, qualification, photo_data, description } = req.body;
    await pool.query(
      `UPDATE teachers SET name = $1, subject = $2, experience = $3, qualification = $4, photo_data = $5, description = $6 WHERE id = $7`,
      [name.trim(), subject.trim(), experience.trim(), qualification ? qualification.trim() : '', photo_data, description ? description.trim() : '', Number(req.params.id)]
    );
    res.json({ message: 'Teacher profile updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update teacher profile.' });
  }
});

app.delete('/api/admin/teachers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM teachers WHERE id = $1', [Number(req.params.id)]);
    res.json({ message: 'Teacher profile removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete teacher.' });
  }
});

// Site Settings
app.get('/api/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM site_settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

app.put('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { instagram_link, facebook_link, whatsapp_number, youtube_link } = req.body;
    const updates = [
      ['instagram_link', instagram_link || ''],
      ['facebook_link', facebook_link || ''],
      ['whatsapp_number', sanitizePhone(whatsapp_number) || '9824528709'],
      ['youtube_link', youtube_link || '']
    ];

    for (const [k, v] of updates) {
      await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [k, v]
      );
    }
    res.json({ message: 'Site settings & social links updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// Student Promotion
app.post('/api/student/promote', authenticateToken, async (req, res) => {
  try {
    const studentId = Number(req.user.id);
    const { to_standard, academic_year } = req.body;

    if (!to_standard) return res.status(400).json({ error: 'Please choose the next standard to switch to.' });

    const sRes = await pool.query('SELECT * FROM users WHERE id = $1', [studentId]);
    const student = sRes.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    await pool.query(
      `INSERT INTO academic_progression_history (student_id, student_name, from_standard, to_standard, previous_fee_paid, academic_year) VALUES ($1, $2, $3, $4, $5, $6)`,
      [studentId, student.name, student.standard, to_standard, student.paid_amount, student.academic_year || '2026-2027']
    );

    const feeRes = await pool.query('SELECT fee_amount, default_monthly_fee FROM standard_fees WHERE standard = $1', [to_standard]);
    const feeRow = feeRes.rows[0];
    const newTotalFee = feeRow ? Number(feeRow.fee_amount) : 15000;
    const newMonthly = feeRow ? Number(feeRow.default_monthly_fee) : 1500;
    const newYear = academic_year || '2027-2028';

    await pool.query(
      `UPDATE users SET standard = $1, total_fees = $2, monthly_fee = $3, paid_amount = 0.0, fee_status = 'Pending', academic_year = $4 WHERE id = $5`,
      [to_standard, newTotalFee, newMonthly, newYear, studentId]
    );

    const msg = `🎉 Congratulations ${student.name}! You have successfully promoted to "${to_standard}" for Academic Session ${newYear}. Your course fee is set to ₹${newTotalFee.toLocaleString()}. Let's achieve top marks together!`;
    await pool.query(`INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`, [studentId, msg]);

    res.json({
      message: `Promoted successfully to ${to_standard}!`,
      standard: to_standard,
      total_fees: newTotalFee,
      academic_year: newYear
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to switch class.' });
  }
});

app.post('/api/admin/student/promote/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const studentId = Number(req.params.id);
    const { to_standard, academic_year } = req.body;

    const sRes = await pool.query('SELECT * FROM users WHERE id = $1', [studentId]);
    const student = sRes.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    await pool.query(
      `INSERT INTO academic_progression_history (student_id, student_name, from_standard, to_standard, previous_fee_paid, academic_year) VALUES ($1, $2, $3, $4, $5, $6)`,
      [studentId, student.name, student.standard, to_standard, student.paid_amount, student.academic_year || '2026-2027']
    );

    const feeRes = await pool.query('SELECT fee_amount, default_monthly_fee FROM standard_fees WHERE standard = $1', [to_standard]);
    const feeRow = feeRes.rows[0];
    const newTotalFee = feeRow ? Number(feeRow.fee_amount) : 15000;
    const newMonthly = feeRow ? Number(feeRow.default_monthly_fee) : 1500;
    const newYear = academic_year || '2027-2028';

    await pool.query(
      `UPDATE users SET standard = $1, total_fees = $2, monthly_fee = $3, paid_amount = 0.0, fee_status = 'Pending', academic_year = $4 WHERE id = $5`,
      [to_standard, newTotalFee, newMonthly, newYear, studentId]
    );

    const msg = `🎉 Academic Update: You have been promoted to "${to_standard}" for Session ${newYear}. New course fee: ₹${newTotalFee.toLocaleString()}. Best of luck!`;
    await pool.query(`INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`, [studentId, msg]);

    res.json({ message: `Student promoted to ${to_standard} successfully!` });
  } catch (err) {
    res.status(500).json({ error: 'Promotion failed.' });
  }
});

// Backup
app.get('/api/admin/backup/summary', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const dRes = await pool.query('SELECT * FROM deleted_students_archive ORDER BY id DESC LIMIT 20');
    const pRes = await pool.query('SELECT * FROM academic_progression_history ORDER BY id DESC LIMIT 20');
    res.json({
      deleted_students: dRes.rows,
      promotion_history: pRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch backup summary.' });
  }
});

app.get('/api/admin/backup/download', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await pool.query('SELECT * FROM users');
    const receipts = await pool.query('SELECT * FROM fee_receipts');
    const marks = await pool.query('SELECT * FROM marks');
    const attendance = await pool.query('SELECT * FROM attendance');
    const archive = await pool.query('SELECT * FROM deleted_students_archive');
    const promotions = await pool.query('SELECT * FROM academic_progression_history');

    const backupDump = {
      export_date: new Date().toISOString(),
      database_engine: 'PostgreSQL_Supabase',
      counts: {
        users: users.rows.length,
        receipts: receipts.rows.length,
        marks: marks.rows.length,
        attendance: attendance.rows.length,
        archived_deleted: archive.rows.length
      },
      data: {
        users: users.rows,
        receipts: receipts.rows,
        marks: marks.rows,
        attendance: attendance.rows,
        deleted_students_archive: archive.rows,
        academic_progression_history: promotions.rows
      }
    };

    const jsonStr = JSON.stringify(backupDump, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="student_backup.json"');
    res.status(200).send(jsonStr);
  } catch (err) {
    console.error('Backup download error:', err);
    res.status(500).send('Backup database export failed.');
  }
});

// Gallery
app.get('/api/gallery', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM gallery ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch gallery.' });
  }
});

app.post('/api/admin/gallery', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, image_data, description, date } = req.body;
    if (!title || !image_data || !date) return res.status(400).json({ error: 'Title, photo, and date required.' });

    await pool.query(
      `INSERT INTO gallery (title, image_data, description, date) VALUES ($1, $2, $3, $4)`,
      [title.trim(), image_data, description ? description.trim() : '', date]
    );
    res.json({ message: 'Photo published to website gallery!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save gallery photo.' });
  }
});

app.delete('/api/admin/gallery/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM gallery WHERE id = $1', [Number(req.params.id)]);
    res.json({ message: 'Photo removed from gallery.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove gallery photo.' });
  }
});

// Student Portal Data
app.get('/api/student/data', authenticateToken, async (req, res) => {
  try {
    const studentId = Number(req.user.id);

    const uRes = await pool.query(
      `SELECT id, name, email, standard, phone, fee_status, payment_plan, monthly_fee, paid_amount, total_fees, academic_year FROM users WHERE id = $1`,
      [studentId]
    );
    const profile = uRes.rows[0];
    if (!profile) return res.status(404).json({ error: 'Student not found.' });

    const tRes = await pool.query(`SELECT morning_batch, evening_batch FROM batch_timings WHERE standard = $1`, [profile.standard]);
    const timings = tRes.rows[0] || { morning_batch: '07:00 AM - 09:30 AM', evening_batch: '04:00 PM - 07:00 PM' };

    const aRes = await pool.query(`SELECT date, status FROM attendance WHERE student_id = $1 ORDER BY date DESC`, [studentId]);
    const attRecords = aRes.rows;
    const totalDays = attRecords.length;
    const presentDays = attRecords.filter(a => a.status === 'Present').length;
    const absentDays = totalDays - presentDays;
    const attendancePercent = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 100;

    const mRes = await pool.query(`SELECT * FROM marks WHERE student_id = $1 ORDER BY id DESC`, [studentId]);
    const matRes = await pool.query(`SELECT * FROM study_materials ORDER BY id DESC`);
    
    const cleanUserStd = (profile.standard || '').toLowerCase().replace(/standard/g, '').replace(/std/g, '').replace(/board/g, '').replace(/[() ]/g, '');
    const matchedMaterials = matRes.rows.filter(mat => {
      if (!mat.standard || mat.standard === 'All Standards' || mat.standard.toLowerCase() === 'all') return true;
      const cleanMatStd = mat.standard.toLowerCase().replace(/standard/g, '').replace(/std/g, '').replace(/board/g, '').replace(/[() ]/g, '');
      return cleanMatStd === cleanUserStd || cleanMatStd.includes(cleanUserStd) || cleanUserStd.includes(cleanMatStd) || mat.standard.toLowerCase().trim() === profile.standard.toLowerCase().trim();
    });

    const msgRes = await pool.query(`SELECT * FROM messages WHERE student_id = $1 ORDER BY id ASC`, [studentId]);
    const messages = msgRes.rows;
    const unreadAdminCount = messages.filter(m => m.sender === 'admin' && Number(m.is_read) === 0).length;

    const rRes = await pool.query(`SELECT * FROM fee_receipts WHERE student_id = $1 ORDER BY id DESC`, [studentId]);
    const receipts = rRes.rows;

    res.json({
      profile: {
        ...profile,
        paid_amount: Number(profile.paid_amount),
        total_fees: Number(profile.total_fees),
        monthly_fee: Number(profile.monthly_fee)
      },
      timings,
      attendance: {
        total_days: totalDays,
        present_days: presentDays,
        absent_days: absentDays,
        percentage: attendancePercent,
        history: attRecords
      },
      receipt: receipts.length > 0 ? receipts[0] : null,
      receipts,
      marks: mRes.rows,
      materials: matchedMaterials,
      messages,
      unread_count: unreadAdminCount
    });
  } catch (err) {
    console.error('Student data error:', err);
    res.status(500).json({ error: 'Failed to fetch student data.' });
  }
});

app.post('/api/student/message', authenticateToken, async (req, res) => {
  try {
    const studentId = Number(req.user.id);
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });

    await pool.query(
      `INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'student', $2, 0)`, 
      [studentId, message.trim()]
    );
    res.json({ message: 'Message sent to admin.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

app.put('/api/student/messages/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(`UPDATE messages SET is_read = 1 WHERE student_id = $1 AND sender = 'admin'`, [Number(req.user.id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark messages read.' });
  }
});

// Admin All Data
app.get('/api/admin/data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const usersRes = await pool.query(`SELECT id, name, email, standard, medium, phone, fee_status, payment_plan, monthly_fee, paid_amount, total_fees, academic_year, role FROM users WHERE role != 'admin' ORDER BY id DESC`);
    const eventsRes = await pool.query(`SELECT * FROM events ORDER BY id DESC`);
    const inqRes = await pool.query(`SELECT * FROM inquiries ORDER BY id DESC`);
    const msgRes = await pool.query(`SELECT messages.*, users.name as student_name FROM messages JOIN users ON messages.student_id = users.id ORDER BY messages.id DESC`);
    const matRes = await pool.query(`SELECT id, title, standard, subject, file_link, file_name, CASE WHEN file_data IS NOT NULL AND file_data != '' THEN 1 ELSE 0 END as has_pdf, created_at FROM study_materials ORDER BY id DESC`);
    const marksRes = await pool.query(`SELECT marks.*, users.name as student_name FROM marks JOIN users ON marks.student_id = users.id ORDER BY marks.id DESC`);
    const feesRes = await pool.query(`SELECT * FROM standard_fees ORDER BY fee_amount ASC`);
    const timingsRes = await pool.query(`SELECT * FROM batch_timings`);
    const galleryRes = await pool.query(`SELECT * FROM gallery ORDER BY id DESC`);
    const teachersRes = await pool.query(`SELECT * FROM teachers ORDER BY id ASC`);
    const settingsRes = await pool.query(`SELECT * FROM site_settings`);

    const settingsMap = {};
    settingsRes.rows.forEach(r => { settingsMap[r.key] = r.value; });

    const totalUnreadMessages = msgRes.rows.filter(m => m.sender === 'student' && Number(m.is_read) === 0).length;
    const totalUnreadInquiries = inqRes.rows.filter(i => Number(i.is_read) === 0).length;

    res.json({ 
      users: usersRes.rows.map(u => ({
        ...u,
        paid_amount: Number(u.paid_amount),
        total_fees: Number(u.total_fees),
        monthly_fee: Number(u.monthly_fee)
      })), 
      events: eventsRes.rows, 
      inquiries: inqRes.rows, 
      messages: msgRes.rows, 
      materials: matRes.rows, 
      marks: marksRes.rows,
      standard_fees: feesRes.rows.map(f => ({
        ...f,
        fee_amount: Number(f.fee_amount),
        default_monthly_fee: Number(f.default_monthly_fee)
      })),
      batch_timings: timingsRes.rows,
      gallery: galleryRes.rows,
      teachers: teachersRes.rows,
      settings: settingsMap,
      unread_messages: totalUnreadMessages,
      unread_inquiries: totalUnreadInquiries
    });
  } catch (err) {
    console.error('Admin data error:', err);
    res.status(500).json({ error: 'Failed to fetch admin data.' });
  }
});

// Analytics
app.get('/api/admin/analytics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const period = req.query.period || 'all';
    let dateCondition = "1=1";

    if (period === '1m') dateCondition = "date::date >= CURRENT_DATE - INTERVAL '30 days'";
    else if (period === '6m') dateCondition = "date::date >= CURRENT_DATE - INTERVAL '180 days'";
    else if (period === '1y') dateCondition = "date::date >= CURRENT_DATE - INTERVAL '365 days'";

    const rRes = await pool.query(`SELECT amount_paid, payment_type, date FROM fee_receipts WHERE ${dateCondition}`);
    let periodCollected = 0;
    rRes.rows.forEach(r => { periodCollected += Number(r.amount_paid || 0); });

    const uRes = await pool.query(`SELECT standard, fee_status, paid_amount, total_fees FROM users WHERE role != 'admin'`);
    let totalRevenueExpected = 0;
    let allTimeCollected = 0;
    const standardDistribution = {};

    uRes.rows.forEach(s => {
      const t = Number(s.total_fees || 0);
      const p = Math.min(t, Number(s.paid_amount || 0));
      totalRevenueExpected += t;
      allTimeCollected += p;
      standardDistribution[s.standard] = (standardDistribution[s.standard] || 0) + 1;
    });

    const displayCollected = period === 'all' ? allTimeCollected : periodCollected;
    const pendingRevenue = Math.max(0, totalRevenueExpected - allTimeCollected);

    res.json({
      period,
      revenue: { total: totalRevenueExpected, collected: displayCollected, pending: pendingRevenue },
      distribution: standardDistribution
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch analytics.' });
  }
});

// CSV Export
app.get('/api/admin/export/students', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, email, phone, standard, payment_plan, monthly_fee, fee_status, paid_amount, total_fees, academic_year FROM users WHERE role != 'admin' ORDER BY id ASC`);
    let csv = 'Roll No,Student Name,Email Address,Phone Number,Standard,Payment Plan,Monthly Fee (INR),Fee Status,Paid Amount (INR),Total Course Fee (INR),Academic Year\n';
    result.rows.forEach(r => {
      const total = Number(r.total_fees || 0);
      const paid = Math.min(total, Number(r.paid_amount || 0));
      csv += `"${r.id}","${r.name}","${r.email}","${r.phone || '-'}","${r.standard}","${r.payment_plan || 'One-Time'}","${r.monthly_fee || 0}","${r.fee_status}","${paid}","${total}","${r.academic_year || '2026-2027'}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="ShapeAndShine_Students_Report.csv"');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).send('Error generating export.');
  }
});

// Bulk Marks
app.get('/api/admin/marks/students/:standard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, standard, phone FROM users WHERE standard = $1 AND role != \'admin\' ORDER BY name ASC', [req.params.standard]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch students for marks.' });
  }
});

app.post('/api/admin/marks/bulk', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { standard, test_name, subject, total_marks, scores } = req.body; 
    if (!standard || !test_name || !subject || !scores || !Array.isArray(scores)) {
      return res.status(400).json({ error: 'Standard, test name, subject, and scores required.' });
    }

    const tMarks = Number(total_marks) || 50;
    for (const s of scores) {
      const sId = Number(s.student_id);
      const scoreVal = Number(s.score) || 0;
      await pool.query(
        `INSERT INTO marks (student_id, test_name, subject, score, total_marks) VALUES ($1, $2, $3, $4, $5)`,
        [sId, test_name.trim(), subject.trim(), scoreVal, tMarks]
      );
      const notif = `🏆 Test Result Released: "${test_name.trim()}" (${subject.trim()}) Score: ${scoreVal} / ${tMarks}. Check your portal!`;
      await pool.query(`INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`, [sId, notif]);
    }

    res.json({ message: `Successfully uploaded marks for ${scores.length} students of ${standard}!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload bulk marks.' });
  }
});

// Attendance
app.get('/api/admin/attendance/:standard/:date', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { standard, date } = req.params;
    const sRes = await pool.query('SELECT id, name, phone, standard FROM users WHERE standard = $1 AND role != \'admin\' ORDER BY name ASC', [standard]);
    const aRes = await pool.query('SELECT student_id, status FROM attendance WHERE date = $1', [date]);

    const statusMap = {};
    aRes.rows.forEach(r => { statusMap[r.student_id] = r.status; });

    const attendanceList = sRes.rows.map(s => ({
      id: s.id,
      name: s.name,
      phone: s.phone,
      standard: s.standard,
      status: statusMap[s.id] || 'Present'
    }));

    res.json({ students: attendanceList, date, standard });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance.' });
  }
});

app.post('/api/admin/attendance', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { date, standard, records } = req.body;
    if (!date || !records || !Array.isArray(records)) return res.status(400).json({ error: 'Date & records required.' });

    for (const r of records) {
      await pool.query(
        `INSERT INTO attendance (student_id, date, status) VALUES ($1, $2, $3)
         ON CONFLICT (student_id, date) DO UPDATE SET status = EXCLUDED.status`,
        [Number(r.student_id), date, r.status]
      );
      if (r.status === 'Absent') {
        const alertMsg = `⚠️ Attendance Alert: You were marked ABSENT on ${date} for ${standard}. Contact coaching if this is an error.`;
        await pool.query(`INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`, [Number(r.student_id), alertMsg]);
      }
    }
    res.json({ message: `Attendance saved for ${records.length} students on ${date}!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save attendance.' });
  }
});

// Batch Timings
app.get('/api/batch-timings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM batch_timings');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch timings.' });
  }
});

app.put('/api/admin/batch-timings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { standard, morning_batch, evening_batch } = req.body;
    await pool.query(
      `INSERT INTO batch_timings (standard, morning_batch, evening_batch, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (standard) DO UPDATE SET morning_batch = EXCLUDED.morning_batch, evening_batch = EXCLUDED.evening_batch, updated_at = CURRENT_TIMESTAMP`,
      [standard, morning_batch.trim(), evening_batch.trim()]
    );
    res.json({ message: `Batch timings updated for ${standard}!` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update batch timings.' });
  }
});

// Fee Receipts
app.post('/api/admin/generate-receipt', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { student_id, amount_paid, payment_mode, payment_type, payment_for_month } = req.body;
    const sid = Number(student_id);
    const paidNow = Number(amount_paid);

    if (!sid || isNaN(paidNow) || paidNow <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount greater than ₹0.' });
    }

    const sRes = await pool.query('SELECT id, name, standard, total_fees, paid_amount, payment_plan, monthly_fee FROM users WHERE id = $1', [sid]);
    const student = sRes.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    const total = Math.max(0, Number(student.total_fees || 15000));
    const alreadyPaid = Math.max(0, Number(student.paid_amount || 0));
    const remainingBalance = Math.max(0, total - alreadyPaid);

    if (remainingBalance <= 0) {
      return res.status(400).json({ error: `Student has already cleared all fees (₹${total.toLocaleString()})! Remaining balance is ₹0.` });
    }

    if (paidNow > remainingBalance) {
      return res.status(400).json({ error: `Entered amount ₹${paidNow.toLocaleString()} exceeds pending balance (₹${remainingBalance.toLocaleString()})!` });
    }

    const newPaidTotal = Math.min(total, alreadyPaid + paidNow);
    const balance = Math.max(0, total - newPaidTotal);
    const newStatus = balance === 0 ? 'Paid' : 'Pending';
    const receiptNo = `SS-REC-${Date.now().toString().slice(-6)}`;
    const today = new Date().toISOString().split('T')[0];

    const pType = payment_type || (student.payment_plan === 'Monthly' ? 'Monthly Installment' : 'One-Time Full');

    await pool.query(
      `INSERT INTO fee_receipts (receipt_no, student_id, student_name, standard, payment_type, payment_for_month, amount_paid, total_fees, balance_amount, payment_mode, date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [receiptNo, sid, student.name, student.standard, pType, payment_for_month || '', paidNow, total, balance, payment_mode || 'Cash / Online UPI', today]
    );

    await pool.query(`UPDATE users SET paid_amount = $1, fee_status = $2 WHERE id = $3`, [newPaidTotal, newStatus, sid]);

    const receiptMsg = `🧾 Official Fee Receipt #${receiptNo}: Received ₹${paidNow.toLocaleString()} (${pType}${payment_for_month ? ' for ' + payment_for_month : ''}) via ${payment_mode || 'Cash/UPI'}. Total Paid: ₹${newPaidTotal.toLocaleString()} | Balance Due: ₹${balance.toLocaleString()}. Thank you!`;
    await pool.query(`INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`, [sid, receiptMsg]);

    res.json({
      message: 'Fee receipt generated and sent to student!',
      receipt: {
        receipt_no: receiptNo,
        student_name: student.name,
        standard: student.standard,
        payment_type: pType,
        payment_for_month: payment_for_month || '',
        amount_paid: paidNow,
        total_fees: total,
        balance_amount: balance,
        payment_mode: payment_mode || 'Cash / Online UPI',
        date: today
      }
    });
  } catch (err) {
    console.error('Receipt generation error:', err);
    res.status(500).json({ error: 'Receipt generation error.' });
  }
});

app.get('/api/receipt/:receiptNo', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM fee_receipts WHERE receipt_no = $1', [req.params.receiptNo]);
    const receipt = result.rows[0];
    if (!receipt) return res.status(404).json({ error: 'Receipt not found.' });
    res.json({
      ...receipt,
      amount_paid: Number(receipt.amount_paid),
      total_fees: Number(receipt.total_fees),
      balance_amount: Number(receipt.balance_amount)
    });
  } catch (err) {
    res.status(500).json({ error: 'Receipt fetch error.' });
  }
});

// Messaging
app.put('/api/admin/messages/read/:studentId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE messages SET is_read = 1 WHERE student_id = $1 AND sender = 'student'`, [Number(req.params.studentId)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update messages.' });
  }
});

app.put('/api/admin/inquiries/read', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE inquiries SET is_read = 1`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update inquiries.' });
  }
});

app.post('/api/admin/reply', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const student_id = Number(req.body.student_id);
    const message = req.body.message ? req.body.message.trim() : '';
    if (!student_id || !message) return res.status(400).json({ error: 'Message cannot be empty.' });

    await pool.query(`INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`, [student_id, message]);
    res.json({ message: 'Reply sent to student!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send reply.' });
  }
});

// Edit Student Profile
app.put('/api/admin/student/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, standard, phone, fee_status, paid_amount, total_fees, payment_plan, monthly_fee } = req.body;
    const tFees = Math.max(0, Number(total_fees) || 0);
    let pAmount = Math.max(0, Number(paid_amount) || 0);

    if (pAmount > tFees) pAmount = tFees;

    let finalStatus = fee_status || 'Pending';
    if (pAmount >= tFees && tFees > 0) finalStatus = 'Paid';
    else if (pAmount < tFees && fee_status === 'Paid') pAmount = tFees;

    const mFee = Number(monthly_fee) || 0;
    const studentId = Number(req.params.id);
    const cleanPhone = sanitizePhone(phone);

    await pool.query(
      `UPDATE users SET name = $1, email = $2, standard = $3, phone = $4, fee_status = $5, paid_amount = $6, total_fees = $7, payment_plan = $8, monthly_fee = $9 WHERE id = $10`,
      [name ? name.trim() : '', email ? email.trim().toLowerCase() : '', standard, cleanPhone, finalStatus, pAmount, tFees, payment_plan || 'One-Time', mFee, studentId]
    );

    const notifMsg = `📢 Fee Status Notice: Your fee status is "${finalStatus}". Paid: ₹${pAmount.toLocaleString()} / Total: ₹${tFees.toLocaleString()} (Plan: ${payment_plan || 'One-Time'}). Thank you!`;
    await pool.query(`INSERT INTO messages (student_id, sender, message, is_read) VALUES ($1, 'admin', $2, 0)`, [studentId, notifMsg]);

    res.json({ message: 'Student updated and notification sent!' });
  } catch (err) {
    console.error('Update student error:', err);
    res.status(500).json({ error: 'Database update failed.' });
  }
});

app.put('/api/admin/standard-fee', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { standard, fee_amount, default_monthly_fee, update_existing } = req.body;
    const numFee = Number(fee_amount);
    const numMonthly = Number(default_monthly_fee) || Math.round(numFee / 10);
    if (!standard || isNaN(numFee) || numFee <= 0) return res.status(400).json({ error: 'Valid standard & fee required.' });

    await pool.query(
      `INSERT INTO standard_fees (standard, fee_amount, default_monthly_fee) VALUES ($1, $2, $3)
       ON CONFLICT (standard) DO UPDATE SET fee_amount = EXCLUDED.fee_amount, default_monthly_fee = EXCLUDED.default_monthly_fee`,
      [standard, numFee, numMonthly]
    );

    if (update_existing) {
      await pool.query(`UPDATE users SET total_fees = $1, monthly_fee = $2 WHERE standard = $3 AND role != 'admin'`, [numFee, numMonthly, standard]);
      res.json({ message: `Updated base fee (₹${numFee}) & monthly fee (₹${numMonthly}) for ${standard}!` });
    } else {
      res.json({ message: `Updated base fee for ${standard}!` });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to update standard fee.' });
  }
});

// Delete Student (Auto-Archived into Backup Table)
app.delete('/api/admin/student/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const studentId = Number(req.params.id);
    const sRes = await pool.query(`SELECT * FROM users WHERE id = $1 AND role != 'admin'`, [studentId]);
    const student = sRes.rows[0];

    if (student) {
      await pool.query(
        `INSERT INTO deleted_students_archive (original_id, name, email, phone, standard, paid_amount, total_fees, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Deleted from admin console')`,
        [student.id, student.name, student.email, student.phone, student.standard, student.paid_amount, student.total_fees]
      );
    }

    await pool.query(`DELETE FROM users WHERE id = $1 AND role != 'admin'`, [studentId]);
    res.json({ message: 'Student deleted and safely backed up to student_backup database!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete student.' });
  }
});

// Study Materials
app.post('/api/admin/materials', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, standard, subject, file_link, file_data, file_name } = req.body;
    if (!title || !standard || !subject) return res.status(400).json({ error: 'Title, standard, and subject required.' });
    if (!file_link && !file_data) return res.status(400).json({ error: 'Please upload a PDF file or provide a web link.' });

    await pool.query(
      `INSERT INTO study_materials (title, standard, subject, file_link, file_data, file_name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [title.trim(), standard, subject.trim(), file_link ? file_link.trim() : '', file_data || '', file_name || '']
    );
    res.json({ message: 'Study material uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload material.' });
  }
});

app.get('/api/materials/file/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT file_data, file_name FROM study_materials WHERE id = $1', [Number(req.params.id)]);
    const row = result.rows[0];
    if (!row || !row.file_data) return res.status(404).json({ error: 'PDF file not found' });
    res.json({ file_data: row.file_data, file_name: row.file_name || 'document.pdf' });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching file.' });
  }
});

app.delete('/api/admin/materials/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_materials WHERE id = $1', [Number(req.params.id)]);
    res.json({ message: 'Study material removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove material.' });
  }
});

// Notices & Events
app.post('/api/admin/events', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, date, description, category } = req.body;
    await pool.query(
      `INSERT INTO events (title, date, description, category) VALUES ($1, $2, $3, $4)`, 
      [title, date, description, category || 'Notice']
    );
    res.json({ message: 'Notice published!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish notice.' });
  }
});

app.delete('/api/admin/events/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM events WHERE id = $1', [Number(req.params.id)]);
    res.json({ message: 'Notice deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete notice.' });
  }
});

app.delete('/api/admin/marks/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM marks WHERE id = $1', [Number(req.params.id)]);
    res.json({ message: 'Mark record removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove mark.' });
  }
});

app.delete('/api/admin/inquiries/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM inquiries WHERE id = $1', [Number(req.params.id)]);
    res.json({ message: 'Inquiry removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove inquiry.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Local Development Server (Only runs if not on Vercel serverless)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔑 Master Admin: admin@shapeandshine.com`);
    console.log(`📁 Connected to Supabase PostgreSQL Database`);
    console.log(`=======================================================`);
  });
}

// Export app for Vercel deployment
module.exports = app;