const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const webpush = require('web-push');
const admin = require('firebase-admin');
 
const app = express();
app.use(cors());
app.use(express.json());
 
const VAPID_PUBLIC = 'BBaEjhW0EUvQPbRPrLbaA2o4XJtXTpVjPyaahGGMYbBPfAJhS9f4fLrmD-wVyq9UOslM3luh7ft5zI_op-DuYZk';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
webpush.setVapidDetails('mailto:scanadrink@scanadrink.com', VAPID_PUBLIC, VAPID_PRIVATE);
 
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://scanadrink-default-rtdb.europe-west1.firebasedatabase.app'
});
const db = admin.database();
 
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, orderData, successUrl, cancelUrl } = req.body;
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'eur',
        product_data: { name: item.name },
        unit_amount: item.price * 100,
      },
      quantity: item.count,
    }));
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl,
      metadata: {
        orderData: JSON.stringify(orderData)
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Called from success page with session_id to confirm payment and save order
app.post('/confirm-order', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }
    const orderData = JSON.parse(session.metadata.orderData);
    const pushRef = await db.ref('orders').push({
      ...orderData,
      status: 'preparing'
    });
    res.json({ firebaseKey: pushRef.key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Save order directly (fallback)
app.post('/save-order', async (req, res) => {
  try {
    const { orderNumber, table, items, total, timestamp } = req.body;
    const pushRef = await db.ref('orders').push({
      orderNumber, table, items, total, timestamp, status: 'preparing'
    });
    res.json({ firebaseKey: pushRef.key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/save-subscription', async (req, res) => {
  try {
    const { firebaseKey, subscription } = req.body;
    if (!firebaseKey || !subscription) return res.status(400).json({ error: 'Missing fields' });
    await db.ref('orders/' + firebaseKey).update({ pushSubscription: JSON.stringify(subscription) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/notify-done', async (req, res) => {
  try {
    const { firebaseKey } = req.body;
    const snapshot = await db.ref('orders/' + firebaseKey).once('value');
    const order = snapshot.val();
    if (!order || !order.pushSubscription) return res.status(404).json({ error: 'No subscription found' });
    const subscription = JSON.parse(order.pushSubscription);
    const payload = JSON.stringify({
      title: 'ScanAdrink 🍹',
      body: `Order #${order.orderNumber} is ready! Head to the bar.`
    });
    await webpush.sendNotification(subscription, payload);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Send reminder notification
app.post('/notify-reminder', async (req, res) => {
  try {
    const { firebaseKey } = req.body;
    const snapshot = await db.ref('orders/' + firebaseKey).once('value');
    const order = snapshot.val();
    if (!order || !order.pushSubscription) return res.status(404).json({ error: 'No subscription' });
    if (order.status !== 'done') return res.json({ skipped: true }); // already confirmed
 
    const subscription = JSON.parse(order.pushSubscription);
    const payload = JSON.stringify({
      title: 'ScanAdrink 🍹',
      body: `Order #${order.orderNumber} is waiting at the bar — come collect your drink!`
    });
    await webpush.sendNotification(subscription, payload);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/', (req, res) => res.send('ScanAdrink backend running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
