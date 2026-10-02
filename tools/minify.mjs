import {minify} from 'terser';

// Build-time only. Keep numeric rewrites conservative so f32 operations survive.
export async function minifyJavaScript(code) {
  const result = await minify(code, {
    ecma: 2020,
    toplevel: true,
    compress: {passes: 3},
    mangle: {toplevel: true},
    format: {comments: false, inline_script: true, ascii_only: true}
  });
  if (typeof result.code !== 'string') throw Error('Terser did not emit JavaScript');
  return result.code;
}

export async function minifyHtml(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw Error('Expected one inline game script');
  const script = scripts[0];
  const code = await minifyJavaScript(script[1]);
  return html.slice(0, script.index) + '<script>' + code + '</script>' +
    html.slice(script.index + script[0].length);
}

export function inlineScriptSource(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw Error('Expected one inline game script');
  return scripts[0][1];
}

export function externalizeInlineScript(html, source) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw Error('Expected one inline game script');
  const escapedSource = String(source).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const script = scripts[0];
  return html.slice(0, script.index) + `<script src="${escapedSource}"></script>` +
    html.slice(script.index + script[0].length);
}
