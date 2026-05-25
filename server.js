const express = require('express');
const stripe = require('stripe')('sk_test_51GSJ0MHOKPhUAJB7yYxBCNypEOeLk8smE73yhw63t4FQ7LNzHGR20FS4eRHUlaW9Ad9UeAcKLaOWFIuk6nfFrQ1200Lgxb9Sig');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // convert euros to cents
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('ScanAdrink backend running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
