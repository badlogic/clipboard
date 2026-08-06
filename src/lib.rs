#![deny(clippy::all)]
use base64::{engine::general_purpose, Engine as _};
#[allow(dead_code, unused_imports)]
mod clipboard_rs;

use clipboard_rs::{
  common::{Result as ClipboardResult, RustImage},
  Clipboard, ClipboardContext, ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext,
  ContentFormat, RustImageData,
};
use napi::{
  bindgen_prelude::*,
  threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
#[cfg(target_os = "linux")]
use std::sync::Mutex;
use std::{sync::Arc, thread, time::Duration};

#[macro_use]
extern crate napi_derive;

fn napi_error(error: impl ToString) -> Error {
  Error::from_reason(error.to_string())
}

#[cfg(target_os = "linux")]
// Keep one healthy X11 context so global API calls share its connections.
// Dropping an unhealthy context stops and joins its selection server thread.
static X11_CLIPBOARD_CONTEXT: Mutex<Option<ClipboardContext>> = Mutex::new(None);

#[cfg(target_os = "linux")]
fn with_clipboard<T>(operation: impl FnOnce(&ClipboardContext) -> ClipboardResult<T>) -> Result<T> {
  let mut shared_context = X11_CLIPBOARD_CONTEXT
    .lock()
    .map_err(|_| Error::from_reason("Clipboard context lock is poisoned"))?;

  if shared_context
    .as_ref()
    .is_some_and(|context| !context.is_healthy())
  {
    *shared_context = None;
  }

  if let Some(context) = shared_context.as_ref() {
    return operation(context).map_err(napi_error);
  }

  let context = ClipboardContext::new().map_err(napi_error)?;
  if context.is_x11() {
    *shared_context = Some(context);
    let context = shared_context
      .as_ref()
      .ok_or_else(|| Error::from_reason("Clipboard context initialization failed"))?;
    return operation(context).map_err(napi_error);
  }

  drop(shared_context);
  operation(&context).map_err(napi_error)
}

#[cfg(not(target_os = "linux"))]
fn with_clipboard<T>(operation: impl FnOnce(&ClipboardContext) -> ClipboardResult<T>) -> Result<T> {
  let context = ClipboardContext::new().map_err(napi_error)?;
  operation(&context).map_err(napi_error)
}

#[napi]
pub fn available_formats() -> Result<Vec<String>> {
  with_clipboard(|context| context.available_formats())
}

#[napi]
pub async fn get_text() -> Result<String> {
  with_clipboard(|context| context.get_text())
}

#[napi]
pub async fn set_text(text: String) -> Result<()> {
  with_clipboard(|context| context.set_text(text))
}

#[napi]
pub fn has_text() -> Result<bool> {
  with_clipboard(|context| Ok(context.has(ContentFormat::Text)))
}

#[napi]
pub async fn get_image_binary() -> Result<Vec<u8>> {
  let image = with_clipboard(|context| context.get_image())?;
  let image_bytes = image.to_png().map_err(napi_error)?.get_bytes().to_vec();
  Ok(image_bytes)
}

#[napi]
pub async fn get_image_base64() -> Result<String> {
  let image_bytes = get_image_binary().await?;
  let base64_str = general_purpose::STANDARD_NO_PAD.encode(&image_bytes);
  Ok(base64_str)
}

#[napi]
pub async fn set_image_binary(image_bytes: Vec<u8>) -> Result<()> {
  let img = RustImageData::from_bytes(&image_bytes).map_err(napi_error)?;
  with_clipboard(|context| context.set_image(img))
}

#[napi]
pub async fn set_image_base64(base64_str: String) -> Result<()> {
  let decoded: Vec<u8> = general_purpose::STANDARD_NO_PAD
    .decode(base64_str)
    .map_err(napi_error)?;
  set_image_binary(decoded).await
}

#[napi]
pub fn has_image() -> Result<bool> {
  with_clipboard(|context| Ok(context.has(ContentFormat::Image)))
}

#[napi]
pub async fn get_html() -> Result<String> {
  with_clipboard(|context| context.get_html())
}

#[napi]
pub async fn set_html(html: String) -> Result<()> {
  with_clipboard(|context| context.set_html(html))
}

#[napi]
fn has_html() -> Result<bool> {
  with_clipboard(|context| Ok(context.has(ContentFormat::Html)))
}

#[napi]
pub async fn get_rtf() -> Result<String> {
  with_clipboard(|context| context.get_rich_text())
}

#[napi]
pub async fn set_rtf(rtf: String) -> Result<()> {
  with_clipboard(|context| context.set_rich_text(rtf))
}

#[napi]
pub fn has_rtf() -> Result<bool> {
  with_clipboard(|context| Ok(context.has(ContentFormat::Rtf)))
}

#[napi]
pub async fn clear() -> Result<()> {
  with_clipboard(|context| context.clear())
}

struct Manager {
  ctx: ClipboardContext,
}

impl Manager {
  pub fn new() -> Self {
    let ctx = ClipboardContext::new().unwrap();
    Manager { ctx }
  }
}

impl ClipboardHandler for Manager {
  fn on_clipboard_change(&mut self) {
    println!(
      "on_clipboard_change, txt = {}",
      self.ctx.get_text().unwrap()
    );
  }
}

#[napi]
pub fn watch() {
  let manager = Manager::new();

  let mut watcher = ClipboardWatcherContext::new().unwrap();

  let watcher_shutdown = watcher.add_handler(manager).get_shutdown_channel();

  thread::spawn(move || {
    thread::sleep(Duration::from_secs(5));
    println!("stop watch!");
    watcher_shutdown.stop();
  });

  println!("start watch!");
  watcher.start_watch();
}

#[napi]
pub fn call_threadsafe_function(callback: Arc<ThreadsafeFunction<u32, ()>>) -> Result<()> {
  for n in 0..10 {
    let tsfn = Arc::clone(&callback);
    thread::spawn(move || {
      tsfn.call(Ok(n), ThreadsafeFunctionCallMode::Blocking);
    });
  }
  Ok(())
}

// #[js_function(1)]
// fn hello(ctx: CallContext) -> Result<JsString, String> {
//   let argument_one = ctx
//     .get::<JsString>(0)
//     .map_err(|err| err.to_string())?
//     .into_utf8()
//     .map_err(|err| err.to_string())?;
//   ctx
//     .env
//     .create_string_from_std(format!("{} world!", argument_one.as_str()?))
// }

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn it_works() {
    watch();
  }
}
