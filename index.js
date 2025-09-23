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
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID ? 'SET' : 'MISSING',
  STAFF_SHEET_ID: process.env.STAFF_SHEET_ID ? 'SET' : 'MISSING',
  ATTENDANCE_SHEET_ID: process.env.ATTENDANCE_SHEET_ID ? 'SET' : 'MISSING'
});

const express = require('express');
const app = express();
const axios = require('axios');
require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const serviceAccountAuth = require('./serviceAccountKey.json');

const userStates = new Map();

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
  // Simplified logic - replace with your actual geofencing
  const offices = {
    'Main': { lat: 9.3509, lon: -0.8125 }, // Example coords for Nyankpala
    'Nyankpala': { lat: 9.3509, lon: -0.8125 }
  };
  for (let [name, { lat, lon }] of Object.entries(offices)) {
    if (Math.abs(latitude - lat) < 0.1 && Math.abs(longitude - lon) < 0.1) {
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

      let user = null;
      try {
        console.log('🔍 Looking up user:', `+${from}`);
        const staffDoc = new GoogleSpreadsheet(process.env.STAFF_SHEET_ID, serviceAccountAuth);
        await staffDoc.loadInfo();
        const staffSheet = staffDoc.sheetsByTitle['Staff Sheet'];
        const staffRows = await staffSheet.getRows();
        console.log('✅ Found', staffRows.length, 'staff rows');
        user = staffRows.find(row => row.get('Phone') === `+${from}`);
        console.log('👤 User found:', user ? user.get('Name') : 'NOT FOUND');
      } catch (error) {
        console.error('❌ Staff sheet error:', error.message);
        await sendMessage(from, 'System error. Please try again or contact admin.');
        return res.sendStatus(500);
      }

      if (!user) {
        console.log('❌ Unauthorized user:', `+${from}`);
        await sendMessage(from, 'Unauthorized user. Please contact admin to add your number.');
        return res.sendStatus(200);
      }

      if (message.type === 'text') {
        const text = message.text.body.toLowerCase();
        console.log('📝 Received text:', text);
        if (text === 'clock in' || text === 'clock out') {
          const allowedLocationsStr = user.get('Allowed Locations') || '';
          const allowedLocations = allowedLocationsStr.split(',').map(s => s.trim()).filter(s => s);
          userStates.set(from, { 
            action: text, 
            name: user.get('Name'), 
            department: user.get('Department'),
            allowedLocations: allowedLocations
          });
          console.log('👤 User:', user ? user.get('Name') : 'NULL');
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

        if (userState.allowedLocations.length === 0 || !userState.allowedLocations.includes(officeName)) {
          await sendMessage(from, 'Not authorized at this location.');
          userStates.delete(from);
          console.log('❌ Unauthorized location');
          return res.sendStatus(200);
        }

        const timestamp = new Date().toISOString();
        const attendanceDoc = new GoogleSpreadsheet(process.env.ATTENDANCE_SHEET_ID, serviceAccountAuth);
        await attendanceDoc.loadInfo();
        const attendanceSheet = attendanceDoc.sheetsByTitle['Attendance Sheet'];
        const rows = await attendanceSheet.getRows();
        let userRow = rows.find(row => row.get('Phone') === `+${from}` && row.get('Time In')?.startsWith(timestamp.split('T')[0]));

        try {
          if (userState.action === 'clock in') {
            if (userRow && userRow.get('Time In')) {
              console.log('❌ Duplicate clock-in for:', from);
              await sendMessage(from, 'You already clocked in today.');
            } else {
              console.log('✅ Creating new clock-in for:', userState.name);
              await attendanceSheet.addRow({
                Name: userState.name,
                Phone: `+${from}`,
                'Time In': timestamp,
                'Time Out': '',
                Location: officeName,
                Department: userState.department
              });
              console.log('✅ Row added to Attendance Sheet');
              console.log(`📤 Sending clock-in confirmation to ${from}`);
              await sendMessage(from, `Clocked in successfully at ${timestamp} at ${officeName}.`);
              console.log('✅ Clock-in message sent');
            }
          } else if (userState.action === 'clock out') {
            if (!userRow || !userRow.get('Time In')) {
              console.log('❌ No clock-in found for clock-out:', from);
              await sendMessage(from, 'No clock-in record found for today.');
            } else if (userRow.get('Time Out')) {
              console.log('❌ Already clocked out today:', from);
              await sendMessage(from, 'You already clocked out today.');
            } else {
              console.log('✅ Updating clock-out for:', userState.name);
              userRow.set('Time Out', timestamp);
              userRow.set('Location', officeName);
              await userRow.save();
              console.log('✅ Row updated with Time Out');
              console.log(`📤 Sending clock-out confirmation to ${from}`);
              await sendMessage(from, `Clocked out successfully at ${timestamp} at ${officeName}.`);
              console.log('✅ Clock-out message sent');
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
