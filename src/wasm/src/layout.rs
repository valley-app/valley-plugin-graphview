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

/// One Barnes-Hut cell, laid out together so a traversal step touches one cache line.
#[derive(Clone, Copy)]
struct Cell {
    x0: f64,
    y0: f64,
    size: f64,
    /// `size * size`, the same product the reference computes per visit.
    size2: f64,
    mass: f64,
    cx: f64,
    cy: f64,
    body: u32,
    bucket: u32,
    children: [u32; 4],
    split: bool,
}

#[derive(Default)]
struct Tree {
    cells: Vec<Cell>,
    next: Vec<u32>,
    scratch: Vec<Cell>,
    remap: Vec<u32>,
    order: Vec<u32>,
}

impl Tree {
    fn clear(&mut self, n: usize) {
        self.cells.clear();
        self.next.clear();
        self.next.resize(n, NONE);
    }

    fn cell(&mut self, x0: f64, y0: f64, size: f64) -> u32 {
        let id = u32::try_from(self.cells.len()).unwrap_or(NONE);
        self.cells.push(Cell { x0, y0, size, size2: size * size, mass: 0.0, cx: 0.0, cy: 0.0, body: NONE, bucket: NONE, children: [NONE; 4], split: false });
        id
    }

    /// Renumbers the cells in the order a full traversal pops them (children pushed 0..3, popped 3..0), so a
    /// repulsion pass walks memory forward. Only storage moves; every cell keeps its values and children.
    fn renumber(&mut self) {
        let count = self.cells.len();
        self.remap.clear();
        self.remap.resize(count, NONE);
        self.scratch.clear();
        self.order.clear();
        self.order.push(0);
        while let Some(cell) = self.order.pop() {
            self.remap[cell as usize] = u32::try_from(self.scratch.len()).unwrap_or(NONE);
            let entry = self.cells[cell as usize];
            self.scratch.push(entry);
            for &child in &entry.children {
                if child != NONE {
                    self.order.push(child);
                }
            }
        }
        for entry in &mut self.scratch {
            for child in &mut entry.children {
                if *child != NONE {
                    *child = self.remap[*child as usize];
                }
            }
        }
        std::mem::swap(&mut self.cells, &mut self.scratch);
    }

    fn in_bucket(&self, cell: &Cell, node: u32) -> bool {
        let mut i = cell.bucket;
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
        let (nx, ny) = (self.x[node as usize], self.y[node as usize]);
        let t = &mut self.tree;
        let entry = &mut t.cells[c];
        if entry.mass == 0.0 && entry.body == NONE && !entry.split {
            entry.body = node;
            entry.mass = 1.0;
            entry.cx = nx;
            entry.cy = ny;
            return;
        }
        if depth >= MAX_DEPTH {
            t.next[node as usize] = entry.bucket;
            entry.bucket = node;
            entry.mass += 1.0;
            return;
        }
        if !entry.split {
            entry.split = true;
            let prev = entry.body;
            entry.body = NONE;
            if prev != NONE {
                self.place(cell, prev, depth);
            }
        }
        self.place(cell, node, depth);
        let entry = &mut self.tree.cells[c];
        let mass = entry.mass;
        let m = mass + 1.0;
        entry.cx = (entry.cx * mass + nx) / m;
        entry.cy = (entry.cy * mass + ny) / m;
        entry.mass = m;
    }

    fn place(&mut self, cell: u32, node: u32, depth: u32) {
        let c = cell as usize;
        let (nx, ny) = (self.x[node as usize], self.y[node as usize]);
        let t = &mut self.tree;
        let entry = t.cells[c];
        let half = entry.size / 2.0;
        let right = nx >= entry.x0 + half;
        let bottom = ny >= entry.y0 + half;
        let slot = if bottom { 2 } else { 0 } + usize::from(right);
        let mut child = entry.children[slot];
        if child == NONE {
            let x0 = entry.x0 + if right { half } else { 0.0 };
            let y0 = entry.y0 + if bottom { half } else { 0.0 };
            child = t.cell(x0, y0, half);
            t.cells[c].children[slot] = child;
        }
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
        self.tree.renumber();

        let strength = repel * alpha;
        let mut stack = std::mem::take(&mut self.stack);
        for node in 0..n {
            let node32 = u32::try_from(node).unwrap_or(NONE);
            let (nx, ny) = (self.x[node], self.y[node]);
            stack.clear();
            stack.push(0);
            let (mut fvx, mut fvy) = (self.vx[node], self.vy[node]);
            while let Some(cell) = stack.pop() {
                let t = &self.tree;
                let entry = &t.cells[cell as usize];
                if entry.mass == 0.0 {
                    continue;
                }
                let mut dx = nx - entry.cx;
                let mut dy = ny - entry.cy;
                let mut d2 = dx * dx + dy * dy;
                if entry.body == node32 && entry.mass == 1.0 {
                    continue;
                }
                let leaf = !entry.split;
                let contains = !leaf && nx >= entry.x0 && nx < entry.x0 + entry.size && ny >= entry.y0 && ny < entry.y0 + entry.size;
                if leaf || (!contains && opens_below_theta(entry.size2, d2)) {
                    let own = entry.body == node32 || (entry.bucket != NONE && t.in_bucket(entry, node32));
                    let cell_mass = entry.mass;
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
                    fvx += (dx / d) * f;
                    fvy += (dy / d) * f;
                    continue;
                }
                for &child in &entry.children {
                    if child != NONE {
                        stack.push(child);
                    }
                }
            }
            self.vx[node] = fvx;
            self.vy[node] = fvy;
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

/// Exactly `size2 / d2 < THETA2` as the reference rounds it, without a division unless the quotient lies within
/// 2^-48 (relative) of THETA2: outside that band the rounded product decides the same way, inside it divides.
#[inline]
fn opens_below_theta(size2: f64, d2: f64) -> bool {
    const MARGIN: f64 = 1.0 / 281_474_976_710_656.0;
    let p = THETA2 * d2;
    if size2 < p * (1.0 - MARGIN) {
        true
    } else if size2 > p * (1.0 + MARGIN) {
        false
    } else {
        size2 / d2 < THETA2
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
