//! The force-layout tick on structure-of-arrays buffers: centering pull, Barnes-Hut repulsion over index-based cells,
//! link springs over CSR adjacency, damped integration. Every floating-point operation runs in the same order as the
//! frozen JavaScript reference (tests/fixtures/layout-goldens.json), so positions are bit-identical.

const DAMPING: f64 = 0.82;
const MAX_VELOCITY: f64 = 60.0;
const THETA: f64 = 0.9;
const THETA2: f64 = THETA * THETA;
const MAX_DEPTH: u32 = 24;
const NONE: u32 = u32::MAX;

/// Upper bounds checked before any allocation, so an oversized request answers 0 instead of aborting the module.
pub const MAX_NODES: u32 = 250_000;
pub const MAX_EDGES: u32 = 1_000_000;

#[derive(Default)]
struct Tree {
    x0: Vec<f64>,
    y0: Vec<f64>,
    size: Vec<f64>,
    mass: Vec<f64>,
    cx: Vec<f64>,
    cy: Vec<f64>,
    body: Vec<u32>,
    children: Vec<u32>,
    bucket: Vec<u32>,
    split: Vec<bool>,
    next: Vec<u32>,
}

impl Tree {
    fn clear(&mut self, n: usize) {
        self.x0.clear();
        self.y0.clear();
        self.size.clear();
        self.mass.clear();
        self.cx.clear();
        self.cy.clear();
        self.body.clear();
        self.children.clear();
        self.bucket.clear();
        self.split.clear();
        self.next.clear();
        self.next.resize(n, NONE);
    }

    fn cell(&mut self, x0: f64, y0: f64, size: f64) -> u32 {
        let id = u32::try_from(self.size.len()).unwrap_or(NONE);
        self.x0.push(x0);
        self.y0.push(y0);
        self.size.push(size);
        self.mass.push(0.0);
        self.cx.push(0.0);
        self.cy.push(0.0);
        self.body.push(NONE);
        self.children.extend_from_slice(&[NONE; 4]);
        self.bucket.push(NONE);
        self.split.push(false);
        id
    }

    fn in_bucket(&self, cell: usize, node: u32) -> bool {
        let mut i = self.bucket[cell];
        while i != NONE {
            if i == node {
                return true;
            }
            i = self.next[i as usize];
        }
        false
    }
}

/// One layout: the buffers JavaScript reads and writes through the exported pointers, plus scratch space.
#[derive(Default)]
pub struct Layout {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub pinned: Vec<u8>,
    pub offsets: Vec<u32>,
    pub targets: Vec<u32>,
    pub forces: [f64; 4],
    pub seed: u32,
    tree: Tree,
    stack: Vec<u32>,
}

impl Layout {
    /// Sizes the buffers for `n` nodes and `m` edges (zero-filled); false when a bound is exceeded.
    pub fn resize(&mut self, n: u32, m: u32) -> bool {
        if n > MAX_NODES || m > MAX_EDGES {
            return false;
        }
        let (n, m) = (n as usize, m as usize);
        for values in [&mut self.x, &mut self.y, &mut self.vx, &mut self.vy] {
            values.clear();
            values.resize(n, 0.0);
        }
        self.pinned.clear();
        self.pinned.resize(n, 0);
        self.offsets.clear();
        self.offsets.resize(n + 1, 0);
        self.targets.clear();
        self.targets.resize(m, 0);
        true
    }

    /// xorshift32 in [0, 1).
    fn random(&mut self) -> f64 {
        let mut s = self.seed;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.seed = s;
        f64::from(s) / 4_294_967_296.0
    }

    fn insert(&mut self, cell: u32, node: u32, depth: u32) {
        let c = cell as usize;
        let t = &mut self.tree;
        if t.mass[c] == 0.0 && t.body[c] == NONE && !t.split[c] {
            t.body[c] = node;
            t.mass[c] = 1.0;
            t.cx[c] = self.x[node as usize];
            t.cy[c] = self.y[node as usize];
            return;
        }
        if depth >= MAX_DEPTH {
            t.next[node as usize] = t.bucket[c];
            t.bucket[c] = node;
            t.mass[c] += 1.0;
            return;
        }
        if !t.split[c] {
            t.split[c] = true;
            let prev = t.body[c];
            t.body[c] = NONE;
            if prev != NONE {
                self.place(cell, prev, depth);
            }
        }
        self.place(cell, node, depth);
        let t = &mut self.tree;
        let mass = t.mass[c];
        let m = mass + 1.0;
        t.cx[c] = (t.cx[c] * mass + self.x[node as usize]) / m;
        t.cy[c] = (t.cy[c] * mass + self.y[node as usize]) / m;
        t.mass[c] = m;
    }

    fn place(&mut self, cell: u32, node: u32, depth: u32) {
        let c = cell as usize;
        let (nx, ny) = (self.x[node as usize], self.y[node as usize]);
        let t = &mut self.tree;
        let half = t.size[c] / 2.0;
        let right = nx >= t.x0[c] + half;
        let bottom = ny >= t.y0[c] + half;
        let slot = c * 4 + if bottom { 2 } else { 0 } + usize::from(right);
        if t.children[slot] == NONE {
            let x0 = t.x0[c] + if right { half } else { 0.0 };
            let y0 = t.y0[c] + if bottom { half } else { 0.0 };
            t.children[slot] = t.cell(x0, y0, half);
        }
        let child = self.tree.children[slot];
        self.insert(child, node, depth + 1);
    }

    /// One tick; `pinned_index` (the dragged node, negative for none) and pinned nodes exert forces but never move.
    #[allow(clippy::too_many_lines)]
    pub fn tick(&mut self, alpha: f64, pinned_index: i32) -> f64 {
        let n = self.x.len();
        if n == 0 {
            return 0.0;
        }
        if n == 1 {
            self.vx[0] = 0.0;
            self.vy[0] = 0.0;
            return 0.0;
        }
        let [center, repel, link, link_dist] = self.forces;
        let center = center * 0.012;
        let repel = repel * 2500.0;
        let link = link * 0.04;

        for i in 0..n {
            self.vx[i] -= self.x[i] * center * alpha;
            self.vy[i] -= self.y[i] * center * alpha;
        }

        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for i in 0..n {
            if self.x[i] < min_x {
                min_x = self.x[i];
            }
            if self.y[i] < min_y {
                min_y = self.y[i];
            }
            if self.x[i] > max_x {
                max_x = self.x[i];
            }
            if self.y[i] > max_y {
                max_y = self.y[i];
            }
        }
        self.tree.clear(n);
        // Math.max(a, b, 1) of the reference: NaN-propagating, so compare explicitly.
        let width = max_x - min_x;
        let height = max_y - min_y;
        let size = js_max(js_max(width, height), 1.0);
        self.tree.cell(min_x, min_y, size);
        for i in 0..n {
            self.insert(0, u32::try_from(i).unwrap_or(NONE), 0);
        }

        let strength = repel * alpha;
        let mut stack = std::mem::take(&mut self.stack);
        for node in 0..n {
            let node32 = u32::try_from(node).unwrap_or(NONE);
            let (nx, ny) = (self.x[node], self.y[node]);
            stack.clear();
            stack.push(0);
            while let Some(cell) = stack.pop() {
                let c = cell as usize;
                let t = &self.tree;
                if t.mass[c] == 0.0 {
                    continue;
                }
                let mut dx = nx - t.cx[c];
                let mut dy = ny - t.cy[c];
                let mut d2 = dx * dx + dy * dy;
                if t.body[c] == node32 && t.mass[c] == 1.0 {
                    continue;
                }
                let leaf = !t.split[c];
                let contains = !leaf && nx >= t.x0[c] && nx < t.x0[c] + t.size[c] && ny >= t.y0[c] && ny < t.y0[c] + t.size[c];
                if leaf || (!contains && (t.size[c] * t.size[c]) / d2 < THETA2) {
                    let own = t.body[c] == node32 || t.in_bucket(c, node32);
                    let cell_mass = t.mass[c];
                    if d2 < 0.01 {
                        dx = (self.random() - 0.5) * 0.1;
                        dy = (self.random() - 0.5) * 0.1;
                        d2 = dx * dx + dy * dy;
                    }
                    let mass = if own { cell_mass - 1.0 } else { cell_mass };
                    if mass <= 0.0 {
                        continue;
                    }
                    let d = d2.sqrt();
                    let f = (strength * mass) / d2;
                    self.vx[node] += (dx / d) * f;
                    self.vy[node] += (dy / d) * f;
                    continue;
                }
                for k in 0..4 {
                    let child = t.children[c * 4 + k];
                    if child != NONE {
                        stack.push(child);
                    }
                }
            }
        }
        self.stack = stack;

        for a in 0..n {
            for e in self.offsets[a] as usize..self.offsets[a + 1] as usize {
                let b = self.targets[e] as usize;
                let dx = self.x[b] - self.x[a];
                let dy = self.y[b] - self.y[a];
                let mut d = (dx * dx + dy * dy).sqrt();
                if d == 0.0 || d.is_nan() {
                    d = 0.01;
                }
                let f = (d - link_dist) * link * alpha;
                let fx = (dx / d) * f;
                let fy = (dy / d) * f;
                self.vx[a] += fx;
                self.vy[a] += fy;
                self.vx[b] -= fx;
                self.vy[b] -= fy;
            }
        }

        let pinned_index = usize::try_from(pinned_index).ok();
        for i in 0..n {
            if Some(i) == pinned_index || self.pinned[i] != 0 {
                self.vx[i] = 0.0;
                self.vy[i] = 0.0;
                continue;
            }
            self.vx[i] *= DAMPING;
            self.vy[i] *= DAMPING;
            let speed = (self.vx[i] * self.vx[i] + self.vy[i] * self.vy[i]).sqrt();
            if speed > MAX_VELOCITY {
                self.vx[i] = (self.vx[i] / speed) * MAX_VELOCITY;
                self.vy[i] = (self.vy[i] / speed) * MAX_VELOCITY;
            }
            self.x[i] += self.vx[i];
            self.y[i] += self.vy[i];
        }
        alpha * 0.98
    }
}

/// JavaScript's two-argument `Math.max`: NaN if either side is NaN.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}
