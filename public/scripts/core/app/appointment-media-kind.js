/**
 * Classify appointment shared media URLs (Firestore / Firebase Storage or plain paths).
 * @param {string} url
 * @returns {'image' | 'pdf' | 'video'}
 */
export function getAppointmentSharedMediaKind(url) {
    const raw = String(url || '');
    let pathForExt = raw;
    try {
        const u = new URL(raw);
        const enc = u.pathname.match(/\/o\/(.+)/);
        if (enc) {
            pathForExt = decodeURIComponent(enc[1].replace(/\+/g, ' '));
        } else {
            pathForExt = u.pathname;
        }
    } catch {
        pathForExt = raw.split('?')[0];
    }
    const lower = pathForExt.toLowerCase();
    const extMatch = lower.match(/\.([a-z0-9]+)(?:\?|#|$)/) || lower.match(/\.([a-z0-9]+)$/);
    const ext = extMatch ? extMatch[1] : '';

    if (ext === 'pdf') return 'pdf';
    if (['mp4', 'webm', 'ogg', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';

    const rawLower = raw.toLowerCase();
    if (rawLower.includes('.pdf')) return 'pdf';
    if (/\.(mp4|webm|ogg|mov|m4v|ogv)(\?|&|#|$)/i.test(rawLower)) return 'video';
    return 'image';
}
