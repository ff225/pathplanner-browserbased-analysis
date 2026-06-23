"""Proof: legacy-mode toggle visibility + Direct/Optimized route-label readability.

Run:  python tests/playwright/pp_legacy_visible_proof.py <port> <prefix> <outdir>
Captures desktop(light/dark) + mobile screenshots of the legacy toggle and
measures WCAG contrast for the .route-type-label-direct / -optimized badges
(injected with the real CSS classes) in both light and dark schemes.
"""
import sys
from playwright.sync_api import sync_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8031"
PREFIX = sys.argv[2] if len(sys.argv) > 2 else "before"
OUTDIR = sys.argv[3] if len(sys.argv) > 3 else "/tmp/pp-legacy-visible-artifacts"
BASE = f"http://127.0.0.1:{PORT}"

CONTRAST_JS = r"""
() => {
  function lum(c){
    const m = c.match(/\d+(\.\d+)?/g).map(Number);
    const [r,g,b] = m.slice(0,3).map(v => {
      v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
    });
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }
  function ratio(fg, bg){
    const L1 = lum(fg), L2 = lum(bg);
    const hi = Math.max(L1,L2), lo = Math.min(L1,L2);
    return (hi+0.05)/(lo+0.05);
  }
  // Build a representative route card using the REAL css classes.
  const host = document.createElement('div');
  host.className = 'route-card-content';
  host.style.padding = '8px';
  host.id = 'pp-proof-card';
  host.innerHTML = `
    <div class="route-card-heading">
      <span class="route-card-name">Direct Route</span>
      <span class="route-type-label route-type-label-direct">DIRECT</span>
    </div>
    <div class="route-card-heading" style="margin-top:6px">
      <span class="route-card-name">Optimized Route</span>
      <span class="route-type-label route-type-label-optimized">OPTIMIZED</span>
    </div>`;
  // place it over the sidebar so it inherits the same page styles
  document.body.appendChild(host);
  function read(sel){
    const el = host.querySelector(sel);
    const cs = getComputedStyle(el);
    // resolve effective background (walk up if transparent)
    let bg = cs.backgroundColor, node = el;
    while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && node.parentElement){
      node = node.parentElement; bg = getComputedStyle(node).backgroundColor;
    }
    return { color: cs.color, background: bg, ratio: +ratio(cs.color, bg).toFixed(2),
             fontSize: cs.fontSize, fontWeight: cs.fontWeight };
  }
  return { direct: read('.route-type-label-direct'),
           optimized: read('.route-type-label-optimized') };
}
"""


def open_sidebar_if_needed(page):
    try:
        box = page.locator('#legacyMode').bounding_box()
        if box and box.get('width', 0) > 0:
            return
    except Exception:
        pass
    try:
        page.locator('#sidebarToggle').click(timeout=1500)
        page.wait_for_timeout(400)
    except Exception:
        pass


def capture(pw, scheme, width, height, tag):
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={'width': width, 'height': height},
                              color_scheme=scheme, device_scale_factor=1)
    page = ctx.new_page()
    page.goto(f"{BASE}/map/", wait_until='domcontentloaded')
    page.wait_for_timeout(1200)
    open_sidebar_if_needed(page)
    # toggle visibility facts
    row = page.locator('#legacyModeRow')
    cb = page.locator('#legacyMode')
    facts = {
        'rowCount': row.count(),
        'checkboxCount': cb.count(),
        'rowVisible': row.first.is_visible() if row.count() else False,
        'checkboxVisible': cb.first.is_visible() if cb.count() else False,
    }
    try:
        facts['labelText'] = page.locator('#legacyModeRow label[for=legacyMode]').first.inner_text().strip()
    except Exception:
        facts['labelText'] = None
    try:
        sub = page.locator('#legacyModeRow .routing-mode-caption-sub')
        facts['subText'] = sub.first.inner_text().strip() if sub.count() else None
    except Exception:
        facts['subText'] = None
    try:
        row.first.scroll_into_view_if_needed(timeout=1500)
    except Exception:
        pass
    page.wait_for_timeout(250)
    # screenshot the toggle row close-up if visible
    try:
        if facts['rowVisible']:
            row.first.screenshot(path=f"{OUTDIR}/{PREFIX}_{tag}_toggle_row.png")
    except Exception as e:
        print(f"  row screenshot skip: {e}")
    page.screenshot(path=f"{OUTDIR}/{PREFIX}_{tag}_full.png", full_page=False)
    # contrast measurement (inject card)
    contrast = page.evaluate(CONTRAST_JS)
    try:
        page.locator('#pp-proof-card').screenshot(path=f"{OUTDIR}/{PREFIX}_{tag}_labels.png")
    except Exception:
        pass
    ctx.close()
    browser.close()
    return facts, contrast


def main():
    with sync_playwright() as pw:
        for scheme, w, h, tag in [
            ('light', 1920, 1080, 'desktop-light'),
            ('dark', 1920, 1080, 'desktop-dark'),
            ('light', 432, 722, 'mobile-light'),
        ]:
            facts, contrast = capture(pw, scheme, w, h, tag)
            print(f"\n=== {PREFIX} / {tag} ===")
            print("toggle:", facts)
            print("DIRECT label:", contrast['direct'])
            print("OPTIMIZED label:", contrast['optimized'])


if __name__ == '__main__':
    main()
