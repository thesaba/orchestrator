<?php
/**
 * phpMyAdmin signon bridge.
 *
 * Deploy this file at the webroot of your phpMyAdmin install (e.g.
 * /var/www/phpmyadmin/signon.php) and point $cfg['Servers'][$i]['SignonURL']
 * at it in phpMyAdmin's config.inc.php. See DEPLOY_GUIDE.md for full setup.
 *
 * Flow:
 *   1. Panel issues a one-time opaque token (POST /api/sites/:id/databases/:dbId/pma-session)
 *      and sends the user's browser here with ?token=...
 *   2. This script redeems the token for real MySQL credentials by calling
 *      the Node API directly over loopback — the token itself never carries
 *      the password, so it's safe to have briefly appeared in a URL/access log.
 *   3. On success, it sets phpMyAdmin's signon session variables and
 *      redirects into phpMyAdmin, now authenticated as that database's user.
 *
 * IMPORTANT: set PMA_BRIDGE_SECRET below to the exact same value as the
 * PMA_BRIDGE_SECRET environment variable configured for the Node API.
 */

// ── Configuration — edit these two lines ────────────────────────────────────
const PMA_BRIDGE_SECRET = 'CHANGE_ME_TO_MATCH_API_ENV';
const NODE_API_INTERNAL_URL = 'http://127.0.0.1:3001/api/internal/pma-consume';
// ─────────────────────────────────────────────────────────────────────────────

session_name('PMASignon');
session_start();

$token = $_GET['token'] ?? '';
if (!is_string($token) || $token === '') {
    http_response_code(400);
    echo 'Missing token.';
    exit;
}

$ch = curl_init(NODE_API_INTERNAL_URL);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'X-Pma-Bridge-Secret: ' . PMA_BRIDGE_SECRET
    ],
    CURLOPT_POSTFIELDS     => json_encode(['token' => $token]),
    CURLOPT_TIMEOUT        => 5
]);
$response = curl_exec($ch);
$status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($response === false || $status !== 200) {
    http_response_code(403);
    echo 'Invalid or expired session token. Go back to the panel and try again.';
    exit;
}

$creds = json_decode($response, true);
if (!is_array($creds) || empty($creds['user']) || !isset($creds['pass']) || empty($creds['db'])) {
    http_response_code(500);
    echo 'Malformed credential response.';
    exit;
}

// These are read by phpMyAdmin's auth_type = 'signon' handler.
$_SESSION['PMA_single_signon_user']     = $creds['user'];
$_SESSION['PMA_single_signon_password'] = $creds['pass'];
$_SESSION['PMA_single_signon_host']     = $creds['host'] ?? '127.0.0.1';

session_write_close();

// Jump straight into the right database instead of the server overview.
header('Location: ./index.php?db=' . urlencode($creds['db']));
exit;
