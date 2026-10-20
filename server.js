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
 
// ===== STOCK LOGIC (same code on the customer page, the bar dashboard and the server) =====
// Stock is tracked per bar and per ingredient. Only "out" items are stored: stock/{bar}/{ingredientKey} = false.
// A bar is "active" while its dashboard is open (it sends a heartbeat: bars/{bar}/lastSeen).
var BAR_MAX_AGE_MS = 120000;
var UNTRACKED_INGREDIENTS = ['Ice', 'Salt & Lime'];
function ingKey(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function drinkNeeds(ingredients) {
  return (ingredients || []).filter(function (n) { return UNTRACKED_INGREDIENTS.indexOf(n) === -1; }).map(ingKey);
}
function uniqueList(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
function activeBarIds(bars, now, maxAgeMs) {
  var ids = [];
  Object.keys(bars || {}).forEach(function (id) {
    var t = bars[id] && bars[id].lastSeen;
    if (typeof t === 'number' && t > 0 && now - t <= maxAgeMs) ids.push(id);
  });
  return ids.sort();
}
function barMissing(stock, barId, needs) {
  var s = (stock && stock[barId]) || {};
  return needs.filter(function (k) { return s[k] === false; });
}
function barCanMakeAll(stock, barId, cart) {
  return cart.every(function (c) { return barMissing(stock, barId, c.needs).length === 0; });
}
// One drink: can at least one active bar make it? (no active bar known = never block)
function drinkAvailable(stock, active, needs) {
  if (!active.length) return true;
  return active.some(function (b) { return barMissing(stock, b, needs).length === 0; });
}
// Whole cart: { ok:true } or { ok:false, reason:'drink'|'combo', names:[...] }
// cart = [{ name, needs:[keys] }]
function checkCart(stock, active, cart) {
  if (!active.length) return { ok: true };
  var bad = cart.filter(function (c) { return !drinkAvailable(stock, active, c.needs); })
    .map(function (c) { return c.name; });
  if (bad.length) return { ok: false, reason: 'drink', names: uniqueList(bad) };
  if (active.some(function (b) { return barCanMakeAll(stock, b, cart); })) return { ok: true };
  return { ok: false, reason: 'combo', names: uniqueList(cart.map(function (c) { return c.name; })) };
}
// Pick the bar for a paid order: a bar that can make everything, the least busy first.
// busy = { barId: number of open orders }. Returns { bar, issue:[drink names to double-check] }
function pickBar(stock, active, cart, busy) {
  if (!active.length) return { bar: null, issue: [] };
  busy = busy || {};
  var byLoad = function (a, b) { return ((busy[a] || 0) - (busy[b] || 0)) || (a < b ? -1 : 1); };
  var ok = active.filter(function (b) { return barCanMakeAll(stock, b, cart); }).sort(byLoad);
  if (ok.length) return { bar: ok[0], issue: [] };
  // Stock changed after payment and nobody can make everything: least problems, then least busy.
  var best = null;
  active.slice().sort(byLoad).forEach(function (b) {
    var problems = cart.filter(function (c) { return barMissing(stock, b, c.needs).length > 0; })
      .map(function (c) { return c.name; });
    if (!best || problems.length < best.problems.length) best = { bar: b, problems: problems };
  });
  return { bar: best.bar, issue: uniqueList(best.problems) };
}
// ===== END STOCK LOGIC =====
 
// Drink name -> ingredient keys (same menu as index.html). Unknown drinks are never blocked.
const MENU_NEEDS = {
 "Vodka & Coke": [
  "absolut-vodka",
  "coca-cola"
 ],
 "Vodka & Red Bull": [
  "absolut-vodka",
  "red-bull"
 ],
 "Vodka & Sprite": [
  "absolut-vodka",
  "sprite"
 ],
 "Vodka & Tonic": [
  "absolut-vodka",
  "fever-tree-tonic"
 ],
 "Vodka & Fanta": [
  "absolut-vodka",
  "fanta-orange"
 ],
 "Vodka & Ginger Beer": [
  "absolut-vodka",
  "ginger-beer"
 ],
 "Gin & Tonic": [
  "tanqueray",
  "fever-tree-tonic"
 ],
 "Gin & Sprite": [
  "tanqueray",
  "sprite"
 ],
 "Gin & Coke": [
  "tanqueray",
  "coca-cola"
 ],
 "Gin & Red Bull": [
  "tanqueray",
  "red-bull"
 ],
 "Gin & Fanta": [
  "tanqueray",
  "fanta-orange"
 ],
 "Gin & Ginger Beer": [
  "tanqueray",
  "ginger-beer"
 ],
 "Whiskey & Coke": [
  "jack-daniel-s",
  "coca-cola"
 ],
 "Whiskey & Ginger": [
  "jameson",
  "ginger-ale"
 ],
 "Whiskey & Red Bull": [
  "jack-daniel-s",
  "red-bull"
 ],
 "Whiskey & Sprite": [
  "jameson",
  "sprite"
 ],
 "Whiskey & Tonic": [
  "jameson",
  "fever-tree-tonic"
 ],
 "Whiskey Neat": [
  "jameson"
 ],
 "Rum & Coke": [
  "bacardi",
  "coca-cola"
 ],
 "Rum & Red Bull": [
  "bacardi",
  "red-bull"
 ],
 "Rum & Sprite": [
  "bacardi",
  "sprite"
 ],
 "Rum & Fanta": [
  "bacardi",
  "fanta-orange"
 ],
 "Rum & Ginger Beer": [
  "bacardi",
  "ginger-beer"
 ],
 "Rum & Tonic": [
  "bacardi",
  "fever-tree-tonic"
 ],
 "Tequila Shot": [
  "tequila"
 ],
 "Sambuca": [
  "sambuca"
 ],
 "Jäger Shot": [
  "jagermeister"
 ],
 "Vodka Shot": [
  "absolut-vodka"
 ],
 "Whiskey Shot": [
  "jack-daniel-s"
 ],
 "Gin Shot": [
  "tanqueray"
 ]
};
 
function cartFromItems(items) {
  return (items || []).map(function (i) { return { name: i.name, needs: MENU_NEEDS[i.name] || [] }; });
}
 
// Reads which bars are open, their stock and how busy they are.
async function getStockState() {
  const snaps = await Promise.all([
    db.ref('bars').once('value'),
    db.ref('stock').once('value'),
    db.ref('orders').once('value')
  ]);
  const bars = snaps[0].val() || {};
  const stock = snaps[1].val() || {};
  const busy = {};
  snaps[2].forEach(function (child) {
    const o = child.val();
    if (o && o.bar && (o.status === 'preparing' || o.status === 'pending')) busy[o.bar] = (busy[o.bar] || 0) + 1;
  });
  return { stock: stock, active: activeBarIds(bars, Date.now(), BAR_MAX_AGE_MS), busy: busy };
}
 
// Before payment: refuse sold-out drinks. If this check itself fails, we do NOT block the customer.
async function stockVerdict(items) {
  try {
    const st = await getStockState();
    return checkCart(st.stock, st.active, cartFromItems(items));
  } catch (e) {
    console.error('Stock check failed (not blocking):', e.message);
    return { ok: true };
  }
}
 
// After payment: choose the bar that will prepare the order.
async function assignBar(items) {
  try {
    const st = await getStockState();
    return pickBar(st.stock, st.active, cartFromItems(items), st.busy);
  } catch (e) {
    console.error('Bar assignment failed (order saved without bar):', e.message);
    return { bar: null, issue: [] };
  }
}
 
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
      text: `Your order #${orderNumber} is ready at the bar. Come collect your drink — show your green screen with your number to the bartender!`,
      html: `
<div style="background-color:#0c0c0e; padding:40px 20px; font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:420px; margin:0 auto; background-color:#141416; border:1px solid rgba(255,255,255,0.07); border-radius:20px; overflow:hidden;">
    <div style="padding:36px 32px 28px; text-align:center;">
      <div style="font-size:12px; letter-spacing:4px; text-transform:uppercase; color:#c9a96e; margin-bottom:20px;">ScanAdrink</div>
      <div style="font-size:46px; line-height:1.2; margin-bottom:14px;">🍹</div>
      <div style="font-family:Georgia,serif; font-size:30px; color:#e8d5b0; margin-bottom:20px;">Your drink is ready!</div>
      <div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:15px; color:rgba(240,237,232,0.6); line-height:1.6; margin-bottom:26px;">
        Order <strong style="color:#e8d5b0;">#${orderNumber}</strong> is ready at the bar.
      </div>
      <div style="font-family:'Helvetica Neue',Arial,sans-serif; font-size:15px; color:rgba(240,237,232,0.85); line-height:1.6;">
        Come collect your drink — show your green screen with your number to the bartender!
      </div>
    </div>
  </div>
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
    const verdict = await stockVerdict(items);
    if (!verdict.ok) {
      const msg = verdict.reason === 'drink'
        ? 'Sold out right now: ' + verdict.names.join(', ')
        : "These drinks can't be prepared together right now, please order them separately: " + verdict.names.join(', ');
      return res.status(409).json({ error: msg });
    }
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
 
    const assign = await assignBar(orderData.items);
    const pushRef = await db.ref('orders').push({
      ...orderData,
      customerEmail: customerEmail || null,
      status: 'preparing',
      ...(assign.bar ? { bar: assign.bar } : {}),
      ...(assign.issue.length ? { stockIssue: assign.issue } : {})
    });
 
    // Track in Mixpanel
    await trackMixpanel('Order Placed', {
      orderNumber: orderData.orderNumber,
      total: orderData.total,
      itemCount: orderData.items ? orderData.items.length : 0,
      drinks: orderData.items ? orderData.items.map(i => i.name).join(', ') : '',
      table: orderData.table,
      bar: assign.bar || 'none'
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
 
    const assign = await assignBar(items);
    const pushRef = await db.ref('orders').push({
      orderNumber, table, items, total, timestamp,
      customerEmail: finalEmail,
      status: 'preparing',
      ...(assign.bar ? { bar: assign.bar } : {}),
      ...(assign.issue.length ? { stockIssue: assign.issue } : {})
    });
 
    // Track in Mixpanel
    await trackMixpanel('Order Placed', {
      orderNumber,
      total,
      itemCount: items ? items.length : 0,
      drinks: items ? items.map(i => i.name).join(', ') : '',
      table,
      bar: assign.bar || 'none'
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
 
 
