// The panel page shell. The UI is the Preact bundle in dist/ (see bundle.ts);
// the CSP allows only same-origin script and style, so it is served as
// /app.js and /app.css.

export function panelHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi control panel</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main id="app"><p>Loading the panel…</p></main>
<script src="/app.js"></script>
</body>
</html>
`;
}
