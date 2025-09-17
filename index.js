
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(functions.config().stripe.secret_key);

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Create Payment Intent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', orderId } = req.body;
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency,
      metadata: { orderId }
    });
    
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process Order
app.post('/process-order', async (req, res) => {
  try {
    const { userId, items, total, shippingAddress, paymentIntentId } = req.body;
    
    // Verify payment
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed' });
    }
    
    // Create order
    const orderRef = await db.collection('orders').add({
      userId,
      items,
      total,
      shippingAddress,
      paymentIntentId,
      status: 'confirmed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update inventory
    const batch = db.batch();
    for (const item of items) {
      const productRef = db.collection('products').doc(item.productId);
      batch.update(productRef, {
        stock: admin.firestore.FieldValue.increment(-item.quantity)
      });
    }
    await batch.commit();
    
    // Clear user's cart
    const cartRef = db.collection('carts').doc(userId);
    await cartRef.delete();
    
    res.json({ orderId: orderRef.id, status: 'success' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Analytics Data
app.get('/analytics', async (req, res) => {
  try {
    // Verify admin access
    const token = req.headers.authorization?.split(' ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Get analytics data
    const ordersSnapshot = await db.collection('orders').get();
    const productsSnapshot = await db.collection('products').get();
    const usersSnapshot = await db.collection('users').get();
    
    const analytics = {
      totalOrders: ordersSnapshot.size,
      totalProducts: productsSnapshot.size,
      totalUsers: usersSnapshot.size,
      totalRevenue: ordersSnapshot.docs.reduce((sum, doc) => sum + (doc.data().total || 0), 0),
      recentOrders: ordersSnapshot.docs
        .sort((a, b) => b.data().createdAt - a.data().createdAt)
        .slice(0, 10)
        .map(doc => ({ id: doc.id, ...doc.data() }))
    };
    
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Email Notification
exports.sendOrderConfirmation = functions.firestore
  .document('orders/{orderId}')
  .onCreate(async (snap, context) => {
    const order = snap.data();
    const orderId = context.params.orderId;
    
    // Get user details
    const userDoc = await db.collection('users').doc(order.userId).get();
    const user = userDoc.data();
    
    // Send email (implement with your preferred email service)
    console.log(`Order confirmation email should be sent to ${user.email} for order ${orderId}`);
    
    return null;
  });

// Update Search Index
exports.updateSearchIndex = functions.firestore
  .document('products/{productId}')
  .onWrite(async (change, context) => {
    const productId = context.params.productId;
    
    if (!change.after.exists) {
      // Product deleted - remove from search index
      return db.collection('search_index').doc(productId).delete();
    }
    
    const product = change.after.data();
    const searchTerms = [
      product.name?.toLowerCase(),
      product.category?.toLowerCase(),
      product.description?.toLowerCase(),
      ...(product.tags || []).map(tag => tag.toLowerCase())
    ].filter(Boolean);
    
    // Update search index
    return db.collection('search_index').doc(productId).set({
      productId,
      name: product.name,
      category: product.category,
      price: product.price,
      image: product.images?.[0],
      searchTerms,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

exports.api = functions.https.onRequest(app);
                
