const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const admin = require('firebase-admin');
 
const app = express();
app.use(cors());
app.use(express.json());
 
// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://scanadrink-default-rtdb.europe-west1.firebasedatabase.app'
});
 
const db = admin.database();
 
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, successUrl, cancelUrl } = req.body;
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
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Save FCM token for an order
app.post('/save-token', async (req, res) => {
  try {
    const { firebaseKey, fcmToken } = req.body;
    if (!firebaseKey || !fcmToken) return res.status(400).json({ error: 'Missing fields' });
    await db.ref('orders/' + firebaseKey).update({ fcmToken });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Send push notification when order is done
app.post('/notify-done', async (req, res) => {
  try {
    const { firebaseKey } = req.body;
    const snapshot = await db.ref('orders/' + firebaseKey).once('value');
    const order = snapshot.val();
    if (!order || !order.fcmToken) return res.status(404).json({ error: 'No token found' });
 
    const message = {
      token: order.fcmToken,
      notification: {
        title: 'ScanAdrink 🍹',
        body: `Order #${order.orderNumber} is ready! Head to the bar.`,
      },
      webpush: {
        notification: {
          title: 'ScanAdrink 🍹',
          body: `Order #${order.orderNumber} is ready! Head to the bar.`,
          icon: '/icon-512.png',
          badge: '/icon-192.png',
          vibrate: [400, 100, 400, 100, 600],
          requireInteraction: true,
        },
        fcmOptions: {
          link: 'https://scanadrink.com/success.html'
        }
      }
    };
 
    await admin.messaging().send(message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/', (req, res) => res.send('ScanAdrink backend running'));
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
 
