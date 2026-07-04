const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const webpush = require('web-push');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
 
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
 
// Email transporter (Namecheap Private Email)
const transporter = nodemailer.createTransport({
  host: 'smtp.privateemail.com',
  port: 465,
  secure: true, // SSL on port 465
  auth: {
    user: 'scanadrink@scanadrink.com',
    pass: process.env.SMTP_PASSWORD
  }
});
 
async function sendReadyEmail(toEmail, orderNumber) {
  if (!toEmail) {
    console.log('No customer email on file, skipping email send.');
    return;
  }
  try {
    await transporter.sendMail({
      from: '"ScanAdrink" <scanadrink@scanadrink.com>',
      to: toEmail,
      subject: 'Your drink is ready 🍹',
      text: `Your order #${orderNumber} is ready at the bar. Come collect your drink and show this screen to the bartender!`,
      html: `<div style="font-family: sans-serif; padding: 20px;">
               <h2>Your drink is ready 🍹</h2>
               <p>Order <strong>#${orderNumber}</strong> is ready at the bar.</p>
               <p>Come collect your drink — show this email to the bartender!</p>
             </div>`
    });
    console.log('Ready email sent to', toEmail);
  } catch (err) {
    console.error('Email send error:', err.message);
  }
}
 
// Mixpanel tracking function
async function trackMixpanel(event, properties) {
  try {
    const data = Buffer.from(JSON.stringify({
      event,
      properties: {
        token: 'd4b5b43f28149806878033df4cec94d3',
        distinct_id: properties.orderNumber ? String(properties.orderNumber) : 'server',
        ...properties
      }
    })).toString('base64');
 
    await fetch('https://api-eu.mixpanel.com/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${data}`
    });
    console.log('Mixpanel event sent:', event);
  } catch (err) {
    console.error('Mixpanel error:', err.message);
  }
}
 
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
    const separator = successUrl.includes('?') ? '&' : '?';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl + separator + 'session_id={CHECKOUT_SESSION_ID}',
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
 
    // Grab the customer's email captured by Stripe (works for card, Apple Pay, Google Pay)
    const customerEmail = session.customer_details ? session.customer_details.email : null;
 
    const pushRef = await db.ref('orders').push({
      ...orderData,
      customerEmail: customerEmail || null,
      status: 'preparing'
    });
 
    // Track in Mixpanel
    await trackMixpanel('Order Placed', {
      orderNumber: orderData.orderNumber,
      total: orderData.total,
      itemCount: orderData.items ? orderData.items.length : 0,
      drinks: orderData.items ? orderData.items.map(i => i.name).join(', ') : '',
      table: orderData.table
    });
 
    res.json({ firebaseKey: pushRef.key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// Save order directly (fallback)
app.post('/save-order', async (req, res) => {
  try {
    const { orderNumber, table, items, total, timestamp, customerEmail, sessionId } = req.body;
 
    // Try to get the real customer email from Stripe if we have a session ID
    let finalEmail = customerEmail || null;
    if (sessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.customer_details && session.customer_details.email) {
          finalEmail = session.customer_details.email;
        }
      } catch (stripeErr) {
        console.error('Could not retrieve Stripe session for email:', stripeErr.message);
      }
    }
 
    const pushRef = await db.ref('orders').push({
      orderNumber, table, items, total, timestamp,
      customerEmail: finalEmail,
      status: 'preparing'
    });
 
    // Track in Mixpanel
    await trackMixpanel('Order Placed', {
      orderNumber,
      total,
      itemCount: items ? items.length : 0,
      drinks: items ? items.map(i => i.name).join(', ') : '',
      table
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
    if (!order) return res.status(404).json({ error: 'Order not found' });
 
    // Existing push notification (harmless - only fires if a subscription exists)
    if (order.pushSubscription) {
      try {
        const subscription = JSON.parse(order.pushSubscription);
        const payload = JSON.stringify({
          title: 'ScanAdrink 🍹',
          body: `Order #${order.orderNumber} is ready! Head to the bar.`
        });
        await webpush.sendNotification(subscription, payload);
      } catch (pushErr) {
        console.error('Push notification error:', pushErr.message);
      }
    }
 
    // Send the "drink ready" email
    await sendReadyEmail(order.customerEmail, order.orderNumber);
 
    // Track in Mixpanel
    await trackMixpanel('Drink Ready', {
      orderNumber: order.orderNumber,
      total: order.total,
      table: order.table
    });
 
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
    if (order.status !== 'done') return res.json({ skipped: true });
 
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
