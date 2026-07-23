const { mssql } = require('./_mssql');

// Event Grid webhook for ACS SMS events. Not JWT-gated (Event Grid can't send a
// bearer token) — protected by a shared ?key= and the Event Grid validation
// handshake. Records carrier delivery outcomes onto dbo.SMS_Log.

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, body: '' };

  const key = (event.queryStringParameters || {}).key;
  if (!process.env.SMS_EVENTS_KEY || key !== process.env.SMS_EVENTS_KEY) {
    return { statusCode: 401, body: 'unauthorized' };
  }

  let events;
  try { events = JSON.parse(event.body || '[]'); } catch { events = []; }
  if (!Array.isArray(events)) events = [events];

  // Subscription-validation handshake (respond synchronously with the code).
  for (const ev of events) {
    if (ev.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validationResponse: ev.data.validationCode }),
      };
    }
  }

  // Delivery reports.
  for (const ev of events) {
    if (ev.eventType === 'Microsoft.Communication.SMSDeliveryReportReceived') {
      const d = ev.data || {};
      if (!d.messageId) continue;
      await mssql(
        `UPDATE dbo.SMS_Log SET delivery_status=@st, delivery_detail=@dt, delivered_at=@at
         WHERE message_id=@mid`,
        { st: (d.deliveryStatus || '').slice(0, 30),
          dt: (d.deliveryStatusDetails || '').slice(0, 200),
          at: d.receivedTimestamp || new Date().toISOString(),
          mid: d.messageId });
    }
  }
  return { statusCode: 200, body: 'ok' };
};
