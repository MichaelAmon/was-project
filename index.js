import process from 'node:process';
import express from 'express';
import axios from 'axios';
import { config } from 'dotenv';

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message, error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason.message || reason, promise);
  process.exit(1);
});

console.log('🚀 App starting...');
console.log('🛠️ Env vars:', {
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN ? 'SET' : 'MISSING',
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID ? 'SET' : 'MISSING'
});

config(); // Load .env
const app = express();
const userStates = new Map();
const attendanceRecords = new Map(); // In-memory storage for attendance

app.use(express.json({ limit: '10mb' })); // Handle large payloads

const sendMessage = async (to, text) => {
  console.log(`📤 Sending to ${to}: "${text.substring(0, 50)}..."`);
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: text }
  };
  try {
    const response = await axios.post(url, data, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
    console.log(`✅ Message sent to ${to}: ${response.status}`);
    return response;
  } catch (error) {
    console.error(`❌ Message FAILED to ${to}:`);
    console.error('  Status:', error.response?.status);
    console.error('  Error:', error.message);
    if (error.response?.data) {
      console.error('  Details:', JSON.stringify(error.response.data, null, 2));
    }
  }
};

const getOfficeName = (latitude, longitude) => {
  // Define offices with specific radii (in degrees)
  const offices = {
    'Main': { lat: 9.3509, lon: -0.8125, radius: 0.5 }, // Example coords for Nyankpala with 0.5-degree radius
    'Nyankpala': { lat: 9.4000, lon: -0.8000, radius: 0.3 } // Example coords with 0.3-degree radius
  };
  for (let [name, { lat, lon, radius }] of Object.entries(offices)) {
    if (Math.abs(latitude - lat) < radius && Math.abs(longitude - lon) < radius) {
      return name;
    }
  }
  return null;
};

app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Webhook received:', JSON.stringify(req.body, null, 2));
    const body = req.body;
    if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from;
      console.log(`📱 Message from: +${from}, Type: ${message.type}, Body: ${message.text?.body || 'N/A'}`);

      // Simple in-memory user check (replace with your own logic if needed)
      const users = new Map([
        ['+233247877745', { name: 'User1', allowedLocations: ['Main', 'Nyankpala'] }],
        // Add more users as needed
      ]);
      const user = users.get(`+${from}`);

      if (!user) {
        console.log('❌ Unauthorized user:', `+${from}`);
        await sendMessage(from, 'Unauthorized user. Please contact admin to add your number.');
        return res.sendStatus(200);
      }

      if (message.type === 'text') {
        const text = message.text.body.toLowerCase();
        console.log('📝 Received text:', text);
        if (text === 'clock in' || text === 'clock out') {
          userStates.set(from, { action: text, name: user.name, allowedLocations: user.allowedLocations });
          console.log('👤 User:', user.name);
          await sendMessage(from, `Please share your location to confirm ${text}.`);
          console.log(`📤 Sent location request to +${from}`);
        }
      } else if (message.type === 'location') {
        const { latitude, longitude } = message.location;
        const officeName = getOfficeName(latitude, longitude);
        if (!officeName) {
          await sendMessage(from, 'Location not at any office. Try again.');
          console.log('❌ Location not matched');
          return res.sendStatus(200);
        }

        const userState = userStates.get(from);
        if (!userState) {
          await sendMessage(from, 'Please send "clock in" or "clock out" first.');
          console.log('❌ No user state found');
          return res.sendStatus(200);
        }

        if (!userState.allowedLocations.includes(officeName)) {
          await sendMessage(from, 'Not authorized at this location.');
          userStates.delete(from);
          console.log('❌ Unauthorized location');
          return res.sendStatus(200);
        }

        const timestamp = new Date().toISOString();
        const record = attendanceRecords.get(from) || { timeIn: null, timeOut: null, location: null };
        let messageText = '';

        try {
          if (userState.action === 'clock in') {
            if (record.timeIn) {
              console.log('❌ Duplicate clock-in for:', from);
              await sendMessage(from, 'You already clocked in today.');
            } else {
              console.log('✅ Clocking in for:', userState.name);
              record.timeIn = timestamp;
              record.location = officeName;
              attendanceRecords.set(from, record);
              messageText = `Clocked in successfully at ${timestamp} at ${officeName}.`;
              console.log('✅ Clock-in recorded');
              await sendMessage(from, messageText);
              console.log(`📤 Sent clock-in confirmation to ${from}`);
            }
          } else if (userState.action === 'clock out') {
            if (!record.timeIn) {
              console.log('❌ No clock-in found for clock-out:', from);
              await sendMessage(from, 'No clock-in record found for today.');
            } else if (record.timeOut) {
              console.log('❌ Already clocked out today:', from);
              await sendMessage(from, 'You already clocked out today.');
            } else {
              console.log('✅ Clocking out for:', userState.name);
              record.timeOut = timestamp;
              attendanceRecords.set(from, record);
              messageText = `Clocked out successfully at ${timestamp} at ${officeName}.`;
              console.log('✅ Clock-out recorded');
              await sendMessage(from, messageText);
              console.log(`📤 Sent clock-out confirmation to ${from}`);
            }
          }
        } catch (error) {
          console.error('❌ Clock action failed:', error.message);
        }

        userStates.delete(from);
      }
      res.sendStatus(200);
    } else {
      console.log('❌ Invalid webhook payload');
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('❌ Webhook processing failed:', error.message);
    res.sendStatus(500);
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === 'proodentwas' && challenge) {
    console.log('🔒 Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('🔒 Webhook verification failed');
    res.sendStatus(403);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎉 Attendance app running on http://0.0.0.0:${PORT}`);
}).on('error', (error) => {
  console.error('❌ Listen error:', error.message);
  process.exit(1);
});
