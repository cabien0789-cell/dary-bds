const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const rateLimit = require('express-rate-limit');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const adminLoginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  handler: (req, res) => {
    res.render('admin-login', { error: 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 1 giờ.' });
  }
});

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dary-bds-secret',
  resave: true,
  rolling: true,
  saveUninitialized: false,
  cookie: { maxAge: 2 * 24 * 60 * 60 * 1000 }
}));

const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017');
let db;

async function connectDB() {
  await client.connect();
  db = client.db('dary-bds');
  console.log('Connected to MongoDB');
}

function getProducts() { return db.collection('products'); }
function getSettings() { return db.collection('settings'); }

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect('/admin/login');
  next();
}

// ─── XÓA ẢNH CLOUDINARY ──────────────────────────────────
function extractPublicId(url) {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z]+$/);
    if (match) return match[1];
  } catch (e) {}
  return null;
}

async function deleteCloudinaryImages(imageObjects) {
  if (!imageObjects || imageObjects.length === 0) return;
  for (const item of imageObjects) {
    const url = typeof item === 'string' ? item : item.url;
    const publicId = extractPublicId(url);
    if (publicId) {
      try { await cloudinary.uploader.destroy(publicId); } catch (e) {}
    }
  }
}

async function deleteCloudinaryVideo(url) {
  if (!url) return;
  const publicId = extractPublicId(url);
  if (publicId) {
    try { await cloudinary.uploader.destroy(publicId, { resource_type: 'video' }); } catch (e) {}
  }
}

function extractImageUrlsFromContent(content) {
  if (!content) return [];
  const urls = [];
  const regex = /<img[^>]+src="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(content)) !== null) urls.push(match[1]);
  return urls;
}

// ─── TRANG CHỦ ────────────────────────────────────────────
app.get('/', async (req, res) => {
  const products = await getProducts().find({ hidden: { $ne: true } }).sort({ pinnedAt: -1, order: 1 }).toArray();
  const settings = await getSettings().findOne({ key: 'contact' });
  res.render('index', { products, settings: settings || {} });
});

// ─── TRANG CHI TIẾT SẢN PHẨM ─────────────────────────────
app.get('/product/:id', async (req, res) => {
  let product;
  try { product = await getProducts().findOne({ _id: new ObjectId(req.params.id) }); } catch { return res.redirect('/'); }
  if (!product) return res.redirect('/');
  const settings = await getSettings().findOne({ key: 'contact' });
  res.render('product', { product, settings: settings || {} });
});

// ─── ADMIN ĐĂNG NHẬP ─────────────────────────────────────
app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin');
  res.render('admin-login', { error: undefined });
});

app.post('/admin/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (username !== adminUsername || password !== adminPassword) {
    return res.render('admin-login', { error: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
  }
  req.session.isAdmin = true;
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ─── ADMIN TRANG CHÍNH ────────────────────────────────────
app.get('/admin', requireAdmin, async (req, res) => {
  const products = await getProducts().find().sort({ pinnedAt: -1, order: 1 }).toArray();
  const settings = await getSettings().findOne({ key: 'contact' });
  res.render('admin', { products, settings: settings || {} });
});

// ─── ADMIN LƯU THÔNG TIN LIÊN HỆ ─────────────────────────
app.post('/admin/settings', requireAdmin, async (req, res) => {
  const { phone, facebook, zalo } = req.body;
  await getSettings().updateOne(
    { key: 'contact' },
    { $set: { key: 'contact', phone: phone || '', facebook: facebook || '', zalo: zalo || '' } },
    { upsert: true }
  );
  res.redirect('/admin');
});

// ─── ADMIN THÊM SẢN PHẨM ─────────────────────────────────
app.post('/admin/products/create', requireAdmin, upload.fields([
  { name: 'images', maxCount: 20 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    const { name, price, location, contact, category, description, avatarIndex } = req.body;

    // Upload ảnh lên Cloudinary — giữ đúng thứ tự file gửi lên
    const uploadedImages = [];
    if (req.files && req.files['images']) {
      for (const file of req.files['images']) {
        try {
          const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              { resource_type: 'image', folder: 'dary-bds/images' },
              (error, result) => { if (error) reject(error); else resolve(result); }
            );
            stream.end(file.buffer);
          });
          uploadedImages.push({ url: result.secure_url, bytes: result.bytes });
        } catch (imgErr) {
          console.error('Image upload error:', imgErr.message);
        }
      }
    }

    // Xác định avatarUrl — không đẩy ảnh lên đầu, giữ nguyên thứ tự
    const avatarIdx = parseInt(avatarIndex) || 0;
    const avatarUrl = (uploadedImages.length > 0 && avatarIdx >= 0 && avatarIdx < uploadedImages.length)
      ? uploadedImages[avatarIdx].url
      : (uploadedImages.length > 0 ? uploadedImages[0].url : '');

    // Upload video lên Cloudinary
    let videoUrl = null;
    if (req.files && req.files['video'] && req.files['video'][0]) {
      try {
        const videoFile = req.files['video'][0];
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'video', folder: 'dary-bds/videos' },
            (error, result) => { if (error) reject(error); else resolve(result); }
          );
          stream.end(videoFile.buffer);
        });
        videoUrl = result.secure_url;
      } catch (vidErr) {
        console.error('Video upload error:', vidErr.message);
      }
    }

    // Tính order = số sản phẩm hiện tại trong cùng category + 1
    const categoryCount = await getProducts().countDocuments({ category: category || 'canho' });
    await getProducts().insertOne({
      name: name || '',
      price: price || '',
      location: location || '',
      contact: contact || '',
      category: category || 'canho',
      description: description || '',
      images: uploadedImages,
      avatarUrl: avatarUrl,
      video: videoUrl,
      hidden: false,
      order: -Date.now(),
      pinnedAt: null,
      createdAt: new Date().toISOString()
    });

    res.redirect('/admin');
  } catch (e) {
    console.error('CREATE ERROR:', e);
    const products = await getProducts().find().sort({ createdAt: -1 }).toArray().catch(() => []);
    const settings = await getSettings().findOne({ key: 'contact' }).catch(() => null);
    res.render('admin', { products, settings: settings || {}, createError: e.message });
  }
});

// ─── ADMIN SỬA SẢN PHẨM ──────────────────────────────────
app.post('/admin/products/:id/edit', requireAdmin, upload.fields([
  { name: 'images', maxCount: 20 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    let product;
    try { product = await getProducts().findOne({ _id: new ObjectId(req.params.id) }); } catch { return res.redirect('/admin'); }
    if (!product) return res.redirect('/admin');

    const { name, price, location, contact, category, description, deleteImages, deleteVideo, avatarUrl, avatarNewIndex } = req.body;

    // Xóa ảnh được chọn xóa
    let currentImages = product.images || [];
    if (deleteImages) {
      const toDelete = Array.isArray(deleteImages) ? deleteImages : [deleteImages];
      const imagesToDelete = currentImages.filter(img => toDelete.includes(img.url));
      await deleteCloudinaryImages(imagesToDelete);
      currentImages = currentImages.filter(img => !toDelete.includes(img.url));
    }

    // Xóa ảnh bị bỏ khỏi nội dung mô tả
    const urlsInDescription = extractImageUrlsFromContent(description);
    const descriptionImagesToDelete = currentImages.filter(img => {
      return img.url && img.url.includes('dary-bds/desc') && !urlsInDescription.includes(img.url);
    });
    if (descriptionImagesToDelete.length > 0) await deleteCloudinaryImages(descriptionImagesToDelete);

    // Upload ảnh mới
    const newlyUploadedImages = [];
    if (req.files && req.files['images']) {
      for (const file of req.files['images']) {
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { resource_type: 'image', folder: 'dary-bds/images' },
            (error, result) => { if (error) reject(error); else resolve(result); }
          );
          stream.end(file.buffer);
        });
        newlyUploadedImages.push({ url: result.secure_url, bytes: result.bytes });
      }
    }

    // Gộp ảnh cũ còn lại + ảnh mới upload — giữ nguyên thứ tự, không đẩy avatar lên đầu
    let allImages = [...currentImages, ...newlyUploadedImages];

    // Xác định avatarUrl — chỉ lưu URL ảnh đại diện, không xáo trộn thứ tự mảng
    let finalAvatarUrl = '';
    if (avatarUrl && avatarUrl !== '') {
      // Chọn ảnh cũ làm avatar — kiểm tra URL đó còn tồn tại trong allImages sau khi xóa
      const stillExists = allImages.some(img => img.url === avatarUrl);
      if (stillExists) {
        finalAvatarUrl = avatarUrl;
      } else if (avatarNewIndex !== undefined && avatarNewIndex !== '') {
        const newIdx = parseInt(avatarNewIndex);
        const absoluteIdx = currentImages.length + newIdx;
        if (!isNaN(newIdx) && absoluteIdx >= 0 && absoluteIdx < allImages.length) {
          finalAvatarUrl = allImages[absoluteIdx].url;
        } else {
          finalAvatarUrl = allImages.length > 0 ? allImages[0].url : '';
        }
      } else {
        finalAvatarUrl = allImages.length > 0 ? allImages[0].url : '';
      }
    } else if (avatarNewIndex !== undefined && avatarNewIndex !== '') {
      // Chọn ảnh mới upload làm avatar
      const newIdx = parseInt(avatarNewIndex);
      const absoluteIdx = currentImages.length + newIdx;
      if (!isNaN(newIdx) && absoluteIdx >= 0 && absoluteIdx < allImages.length) {
        finalAvatarUrl = allImages[absoluteIdx].url;
      } else {
        finalAvatarUrl = allImages.length > 0 ? allImages[0].url : '';
      }
    } else {
      // Không có lựa chọn mới — giữ avatarUrl cũ nếu còn trong allImages, không thì lấy ảnh đầu tiên
      const oldAvatarStillExists = product.avatarUrl && allImages.some(img => img.url === product.avatarUrl);
      finalAvatarUrl = oldAvatarStillExists ? product.avatarUrl : (allImages.length > 0 ? allImages[0].url : '');
    }

    // Xử lý video
    let videoUrl = product.video || null;
    if (deleteVideo === 'yes') {
      await deleteCloudinaryVideo(product.video);
      videoUrl = null;
    }
    if (req.files && req.files['video'] && req.files['video'][0]) {
      await deleteCloudinaryVideo(product.video);
      const videoFile = req.files['video'][0];
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: 'video', folder: 'dary-bds/videos' },
          (error, result) => { if (error) reject(error); else resolve(result); }
        );
        stream.end(videoFile.buffer);
      });
      videoUrl = result.secure_url;
    }

    await getProducts().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: {
        name: name || '',
        price: price || '',
        location: location || '',
        contact: contact || '',
        category: category || 'canho',
        description: description || '',
        images: allImages,
        avatarUrl: finalAvatarUrl,
        video: videoUrl
      }}
    );

    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.redirect('/admin');
  }
});

// ─── ADMIN XÓA SẢN PHẨM ──────────────────────────────────
app.post('/admin/products/:id/delete', requireAdmin, async (req, res) => {
  try {
    let product;
    try { product = await getProducts().findOne({ _id: new ObjectId(req.params.id) }); } catch { return res.redirect('/admin'); }
    if (!product) return res.redirect('/admin');
    await deleteCloudinaryImages(product.images || []);
    await deleteCloudinaryVideo(product.video);
    await getProducts().deleteOne({ _id: new ObjectId(req.params.id) });
    res.redirect('/admin');
  } catch (e) {
    res.redirect('/admin');
  }
});

// ─── ADMIN UPLOAD ẢNH CHO MÔ TẢ ─────────────────────────
app.post('/admin/products/:id/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    let product;
    try { product = await getProducts().findOne({ _id: new ObjectId(req.params.id) }); } catch { return res.json({ error: 'Lỗi.' }); }
    if (!product) return res.json({ error: 'Không tìm thấy sản phẩm.' });
    if (!req.file) return res.json({ error: 'Không có file.' });
    if (!['image/png', 'image/jpeg'].includes(req.file.mimetype)) return res.json({ error: 'Chỉ chấp nhận png hoặc jpg/jpeg.' });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'image', folder: 'dary-bds/desc' },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      stream.end(req.file.buffer);
    });

    await getProducts().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $push: { images: { url: result.secure_url, bytes: result.bytes } } }
    );

    res.json({ url: result.secure_url, bytes: result.bytes });
  } catch (e) {
    res.json({ error: 'Upload thất bại.' });
  }
});

// ─── ADMIN KÉO THẢ THỨ TỰ SẢN PHẨM ────────────────────────
app.post('/admin/products/reorder', requireAdmin, async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.json({ error: 'Dữ liệu không hợp lệ.' });
  try {
    // Lấy pinnedAt của từng item để biết thuộc nhóm nào
    const ids = order.map(id => new ObjectId(id));
    const products = await getProducts().find({ _id: { $in: ids } }, { projection: { _id: 1, pinnedAt: 1 } }).toArray();
    const pinnedMap = {};
    products.forEach(p => { pinnedMap[String(p._id)] = !!p.pinnedAt; });

    // Gán order riêng cho 2 nhóm: ghim dùng 0,1,2...; không ghim dùng 100000,100001,...
    // Nhờ vậy sort { pinnedAt: -1, order: 1 } giữ đúng thứ tự từng nhóm sau khi kéo thả
    let pinnedCounter = 0;
    let unpinnedCounter = 100000;
    for (const id of order) {
      const orderVal = pinnedMap[id] ? pinnedCounter++ : unpinnedCounter++;
      await getProducts().updateOne(
        { _id: new ObjectId(id) },
        { $set: { order: orderVal } }
      );
    }
    res.json({ ok: true });
  } catch (e) { res.json({ error: 'Lỗi.' }); }
});

// ─── ADMIN GHIM / BỎ GHIM SẢN PHẨM ─────────────────────────
app.post('/admin/products/:id/pin', requireAdmin, async (req, res) => {
  try {
    let product;
    try { product = await getProducts().findOne({ _id: new ObjectId(req.params.id) }); } catch { return res.json({ error: 'Lỗi.' }); }
    if (!product) return res.json({ error: 'Không tìm thấy.' });
    const isPinned = !!product.pinnedAt;
    await getProducts().updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { pinnedAt: isPinned ? null : new Date().toISOString() } }
    );
    res.json({ ok: true, pinned: !isPinned });
  } catch (e) { res.json({ error: 'Lỗi.' }); }
});

// ─── ERROR ────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  try { res.status(500).render('404'); } catch (e) { res.status(500).send('Internal Server Error'); }
});

app.use((req, res) => {
  res.status(404).render('404');
});

// ─── START ────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(3000, () => console.log('Dary BDS running on port 3000'));
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});