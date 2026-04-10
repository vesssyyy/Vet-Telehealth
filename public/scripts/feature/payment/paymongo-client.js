// PayMongo client-side calls (public key only). Card data goes directly to PayMongo, not your server.
const PAYMONGO_API = 'https://api.paymongo.com/v1';

function authHeader(publicKey) {
    const key = (publicKey || '').trim();
    if (!key) throw new Error('PayMongo public key is not set.');
    return 'Basic ' + btoa(key + ':');
}

/**
 * @param {string} publicKey
 * @param {{ cardNumber: string, expMonth: number, expYear: number, cvc: string, name: string, email: string }} details
 * @returns {Promise<string>} payment method id (pm_…)
 */
export async function createCardPaymentMethod(publicKey, details) {
    const cardNumber = String(details.cardNumber || '').replace(/\s/g, '');
    const body = {
        data: {
            attributes: {
                type: 'card',
                details: {
                    card_number: cardNumber,
                    exp_month: Number(details.expMonth),
                    exp_year: Number(details.expYear),
                    cvc: String(details.cvc || ''),
                },
                billing: {
                    name: String(details.name || '').trim(),
                    email: String(details.email || '').trim(),
                },
            },
        },
    };
    const res = await fetch(`${PAYMONGO_API}/payment_methods`, {
        method: 'POST',
        headers: {
            Authorization: authHeader(publicKey),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const e = json.errors && json.errors[0];
        throw new Error((e && (e.detail || e.title)) || 'Card could not be verified.');
    }
    return json.data.id;
}

/**
 * @param {string} publicKey
 * @param {{ name: string, email: string, phone?: string }} details
 * @returns {Promise<string>} payment method id (pm_…)
 */
export async function createQrPhPaymentMethod(publicKey, details) {
    const body = {
        data: {
            attributes: {
                type: 'qrph',
                billing: {
                    name: String(details.name || '').trim(),
                    email: String(details.email || '').trim(),
                    phone: String(details.phone || '').trim(),
                },
            },
        },
    };
    const res = await fetch(`${PAYMONGO_API}/payment_methods`, {
        method: 'POST',
        headers: {
            Authorization: authHeader(publicKey),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const e = json.errors && json.errors[0];
        throw new Error((e && (e.detail || e.title)) || 'QRPh method could not be created.');
    }
    return json.data.id;
}

