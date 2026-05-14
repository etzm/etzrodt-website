// Rate limit: max submissions per IP per window
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(env.ALLOWED_ORIGIN),
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, env.ALLOWED_ORIGIN);
    }

    // Origin validation — reject requests not from the allowed origin
    const origin = request.headers.get("Origin");
    if (!origin || origin !== env.ALLOWED_ORIGIN) {
      return jsonResponse({ error: "Forbidden" }, 403, env.ALLOWED_ORIGIN);
    }

    // Rate limiting by IP using KV
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateLimitKey = `rate:${clientIP}`;

    if (env.RATE_LIMIT) {
      const current = await env.RATE_LIMIT.get(rateLimitKey);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= RATE_LIMIT_MAX) {
        return jsonResponse(
          { error: "Zu viele Anfragen. Bitte versuchen Sie es später erneut." },
          429,
          env.ALLOWED_ORIGIN
        );
      }

      await env.RATE_LIMIT.put(rateLimitKey, String(count + 1), {
        expirationTtl: RATE_LIMIT_WINDOW,
      });
    }

    try {
      const data = await request.formData();
      const name = (data.get("name") || "").trim();
      const email = (data.get("email") || "").trim();
      const subject = (data.get("subject") || "").trim();
      const message = (data.get("message") || "").trim();
      const honeypot = (data.get("_gotcha") || "").trim();

      // Honeypot check
      if (honeypot) {
        return jsonResponse({ success: true }, 200, env.ALLOWED_ORIGIN);
      }

      // Validation
      if (!name || !email || !message) {
        return jsonResponse({ error: "Bitte füllen Sie alle Pflichtfelder aus." }, 400, env.ALLOWED_ORIGIN);
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: "Bitte geben Sie eine gültige E-Mail-Adresse ein." }, 400, env.ALLOWED_ORIGIN);
      }

      // Send email via Brevo (Sendinblue)
      const emailResponse = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          sender: { email: env.FROM_EMAIL, name: `${name} (Kontaktformular)` },
          to: [{ email: env.TO_EMAIL, name: "Martin Etzrodt" }],
          replyTo: { email: email, name: name },
          subject: subject || `Kontaktformular: Nachricht von ${name}`,
          textContent: [
            `Name: ${name}`,
            `E-Mail: ${email}`,
            subject ? `Betreff: ${subject}` : null,
            ``,
            message,
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      });

      if (!emailResponse.ok) {
        console.error("Brevo error:", await emailResponse.text());
        return jsonResponse({ error: "Nachricht konnte nicht gesendet werden. Bitte versuchen Sie es später." }, 500, env.ALLOWED_ORIGIN);
      }

      return jsonResponse({ success: true }, 200, env.ALLOWED_ORIGIN);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Ein Fehler ist aufgetreten." }, 500, env.ALLOWED_ORIGIN);
    }
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}
