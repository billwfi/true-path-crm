const { mssql } = require('./_mssql');

// Event Grid webhook for ACS Email events — updates per-recipient delivery status
// (Delivered / Bounced / Opened) on Email_Campaign_Recipients, keyed by messageId.
// Shared ?key= (SMS_EVENTS_KEY) + Event Grid validation handshake; no JWT.

const DELIVERED = new Set(['Delivered']);
const FAILED = new Set(['Bounced', 'Failed', 'Quarantined', 'FilteredSpam', 'Suppressed']);

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, body: '' };
  const key = (event.queryStringParameters || {}).key;
  if (!process.env.SMS_EVENTS_KEY || key !== process.env.SMS_EVENTS_KEY) return { statusCode: 401, body: 'unauthorized' };

  let events;
  try { events = JSON.parse(event.body || '[]'); } catch { events = []; }
  if (!Array.isArray(events)) events = [events];

  for (const ev of events) {
    if (ev.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ validationResponse: ev.data.validationCode }) };
    }
  }

  for (const ev of events) {
    const d = ev.data || {};
    if (ev.eventType === 'Microsoft.Communication.EmailDeliveryReportReceived' && d.messageId) {
      if (DELIVERED.has(d.status)) {
        await mssql(`UPDATE dbo.Email_Campaign_Recipients SET status='Delivered', delivered_at=GETDATE()
                     WHERE message_id=@m AND status IN ('Sent','Pending')`, { m: d.messageId });
      } else if (FAILED.has(d.status)) {
        // deliveryStatusDetails is an object ({ statusMessage: "SMTP; 550 ..." }), not a string.
        const dsd = d.deliveryStatusDetails;
        const reason = (dsd && typeof dsd === 'object')
          ? (dsd.statusMessage || dsd.StatusMessage || JSON.stringify(dsd))
          : (dsd || '');
        await mssql(`UPDATE dbo.Email_Campaign_Recipients SET status='Bounced', bounced_at=GETDATE(),
                     error=@e WHERE message_id=@m`, { e: (d.status + ': ' + reason).slice(0, 400), m: d.messageId });
      }
    } else if (ev.eventType === 'Microsoft.Communication.EmailEngagementTrackingReportReceived' && d.messageId) {
      if ((d.engagementType || '').toLowerCase() === 'view') {
        await mssql(`UPDATE dbo.Email_Campaign_Recipients SET opened_at=COALESCE(opened_at,GETDATE()),
                     status=CASE WHEN status='Bounced' THEN status ELSE 'Opened' END WHERE message_id=@m`, { m: d.messageId });
      }
    }
  }
  return { statusCode: 200, body: 'ok' };
};
