//! Graph View's force-layout kernel. JavaScript creates one layout per canvas, selects it, writes positions,
//! velocities, pinned flags and CSR adjacency straight into the exported buffers (`layout_x` … `layout_targets`
//! return their addresses in the host-owned `env.memory`), then calls `layout_tick(alpha, pinned_index) -> alpha`
//! once per animation frame and reads the positions back. The Valley ABI exports are present because the host
//! requires them of every module; `valley_call` answers no method.

#[forbid(unsafe_code)]
mod layout;

use std::cell::RefCell;

use layout::Layout;
use valley_plugin_abi::{ABI_VERSION, Status, encode_response, pack_region};

thread_local! {
    static LAYOUTS: RefCell<Vec<Option<Layout>>> = const { RefCell::new(Vec::new()) };
    static SELECTED: RefCell<usize> = const { RefCell::new(usize::MAX) };
}

fn address<T>(values: &[T]) -> u32 {
    u32::try_from(values.as_ptr() as usize).unwrap_or(0)
}

fn with_selected<R>(fallback: R, run: impl FnOnce(&mut Layout) -> R) -> R {
    let selected = SELECTED.with(|selected| *selected.borrow());
    LAYOUTS.with(|layouts| match layouts.borrow_mut().get_mut(selected) {
        Some(Some(layout)) => run(layout),
        _ => fallback,
    })
}

/// A new, empty layout (handle ≥ 1), selected.
#[unsafe(no_mangle)]
pub extern "C" fn layout_create() -> u32 {
    LAYOUTS.with(|layouts| {
        let mut layouts = layouts.borrow_mut();
        let index = layouts.iter().position(Option::is_none).unwrap_or(layouts.len());
        if index == layouts.len() {
            layouts.push(None);
        }
        layouts[index] = Some(Layout::default());
        SELECTED.with(|selected| *selected.borrow_mut() = index);
        u32::try_from(index + 1).unwrap_or(0)
    })
}

/// Selects a layout for the calls that follow; 0 when the handle is unknown.
#[unsafe(no_mangle)]
pub extern "C" fn layout_select(handle: u32) -> u32 {
    let index = (handle as usize).wrapping_sub(1);
    let known = LAYOUTS.with(|layouts| matches!(layouts.borrow().get(index), Some(Some(_))));
    if known {
        SELECTED.with(|selected| *selected.borrow_mut() = index);
    }
    u32::from(known)
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_destroy(handle: u32) {
    let index = (handle as usize).wrapping_sub(1);
    LAYOUTS.with(|layouts| {
        if let Some(slot) = layouts.borrow_mut().get_mut(index) {
            *slot = None;
        }
    });
}

/// Sizes the selected layout's buffers for `nodes` and `edges` (zero-filled, addresses change); 0 above the bounds.
#[unsafe(no_mangle)]
pub extern "C" fn layout_resize(nodes: u32, edges: u32) -> u32 {
    with_selected(0, |layout| u32::from(layout.resize(nodes, edges)))
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_x() -> u32 {
    with_selected(0, |layout| address(&layout.x))
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_y() -> u32 {
    with_selected(0, |layout| address(&layout.y))
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_vx() -> u32 {
    with_selected(0, |layout| address(&layout.vx))
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_vy() -> u32 {
    with_selected(0, |layout| address(&layout.vy))
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_pinned() -> u32 {
    with_selected(0, |layout| address(&layout.pinned))
}

/// CSR row offsets (nodes + 1 entries) into `layout_targets`.
#[unsafe(no_mangle)]
pub extern "C" fn layout_offsets() -> u32 {
    with_selected(0, |layout| address(&layout.offsets))
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_targets() -> u32 {
    with_selected(0, |layout| address(&layout.targets))
}

#[unsafe(no_mangle)]
pub extern "C" fn layout_forces(center: f64, repel: f64, link: f64, link_distance: f64) {
    with_selected((), |layout| layout.forces = [center, repel, link, link_distance]);
}

/// Seeds the coincident-point jitter (xorshift32; 0 is replaced by 1 because xorshift never leaves 0).
#[unsafe(no_mangle)]
pub extern "C" fn layout_seed(seed: u32) {
    with_selected((), |layout| layout.seed = seed.max(1));
}

/// One tick of the selected layout; returns the decayed alpha (`alpha * 0.98`, 0 below two nodes).
#[unsafe(no_mangle)]
pub extern "C" fn layout_tick(alpha: f64, pinned_index: i32) -> f64 {
    with_selected(0.0, |layout| layout.tick(alpha, pinned_index))
}

fn leak(bytes: Vec<u8>) -> u64 {
    let boxed = bytes.into_boxed_slice();
    let len = u32::try_from(boxed.len()).unwrap_or(0);
    let ptr = Box::into_raw(boxed).cast::<u8>() as usize;
    pack_region(u32::try_from(ptr).unwrap_or(0), len)
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_alloc(len: u32) -> u32 {
    let ptr = Box::into_raw(vec![0_u8; len as usize].into_boxed_slice()).cast::<u8>() as usize;
    u32::try_from(ptr).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn valley_free(ptr: u32, len: u32) {
    if ptr == 0 {
        return;
    }
    // SAFETY: `ptr`/`len` describe a boxed slice this module leaked from `valley_alloc` or a response frame; the host
    // frees each region exactly once.
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr as usize as *mut u8, len as usize)) });
}

/// The frame-dispatched entry: the kernel is driven through its direct exports, so every method is unknown.
#[unsafe(no_mangle)]
pub extern "C" fn valley_call(_ptr: u32, _len: u32) -> u64 {
    leak(encode_response(Status::Error, b"graphView layout has no framed methods; call the layout_* exports"))
}
