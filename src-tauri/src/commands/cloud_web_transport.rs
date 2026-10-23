use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_IO_PENDING, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED};
use windows::Win32::System::Pipes::WaitNamedPipeW;
use windows::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

pub(super) struct Transaction<'a> {
    pipe: File,
    deadline: Instant,
    cancellation: &'a AtomicU64,
    generation: u64,
}

impl<'a> Transaction<'a> {
    fn check(&self) -> io::Result<()> {
        if self.cancellation.load(Ordering::Acquire) != self.generation {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "request cancelled",
            ));
        }
        if Instant::now() >= self.deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "request deadline exceeded",
            ));
        }
        Ok(())
    }

    fn transfer(&self, bytes: &mut [u8], write: bool) -> io::Result<()> {
        let pipe = HANDLE(self.pipe.as_raw_handle());
        let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }?;
        let event = unsafe { OwnedHandle::from_raw_handle(event.0) };
        let mut offset = 0;
        while offset < bytes.len() {
            self.check()?;
            unsafe { ResetEvent(HANDLE(event.as_raw_handle())) }?;
            let mut operation = OVERLAPPED {
                hEvent: HANDLE(event.as_raw_handle()),
                ..Default::default()
            };
            let mut transferred = 0;
            let started = unsafe {
                if write {
                    WriteFile(pipe, Some(&bytes[offset..]), None, Some(&mut operation))
                } else {
                    ReadFile(pipe, Some(&mut bytes[offset..]), None, Some(&mut operation))
                }
            };
            if let Err(error) = started {
                if error.code() != ERROR_IO_PENDING.to_hresult() {
                    return Err(error.into());
                }
            }
            let completion = loop {
                if let Err(error) = self.check() {
                    break Err(error);
                }
                let wait = unsafe { WaitForSingleObject(operation.hEvent, 50) };
                if wait == WAIT_OBJECT_0 {
                    break Ok(());
                }
                if wait != WAIT_TIMEOUT {
                    break Err(io::Error::last_os_error());
                }
            };
            if let Err(error) = completion {
                // The OS must release the OVERLAPPED and buffer before they
                // leave this scope, including timeout and cancellation paths.
                unsafe {
                    let _ = CancelIoEx(pipe, Some(&operation));
                    let _ = GetOverlappedResult(pipe, &operation, &mut transferred, true);
                }
                return Err(error);
            }
            unsafe { GetOverlappedResult(pipe, &operation, &mut transferred, false) }?;
            if transferred == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "pipe closed"));
            }
            offset += transferred as usize;
        }
        Ok(())
    }
}

// Consume shared pixels while the server still owns this transaction. Only
// acknowledge after the consumer has copied/closed every transferred handle.
pub(super) fn request<T>(
    process_id: u32,
    message: &Value,
    cancellation: &AtomicU64,
    generation: u64,
    consume: impl FnOnce(Value) -> io::Result<T>,
) -> io::Result<T> {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let pipe_path = format!(r"\\.\pipe\MaaEnd.CloudWeb.{process_id}");
    let pipe_name: Vec<u16> = pipe_path.encode_utf16().chain(Some(0)).collect();
    let pipe = loop {
        if cancellation.load(Ordering::Acquire) != generation {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "request cancelled",
            ));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "pipe connection timed out",
            ));
        }
        match OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OVERLAPPED.0)
            .open(&pipe_path)
        {
            Ok(pipe) => break pipe,
            Err(error) if error.raw_os_error() == Some(231) => unsafe {
                // Waiting does not reserve a pipe instance. Retry only before
                // sending anything, and poll cancellation even during contention.
                let _ = WaitNamedPipeW(PCWSTR(pipe_name.as_ptr()), 50);
            },
            Err(error) => return Err(error),
        }
    };
    let transaction = Transaction {
        pipe,
        deadline,
        cancellation,
        generation,
    };
    let mut body = serde_json::to_vec(message)?;
    if body.is_empty() || body.len() > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid request length",
        ));
    }
    transaction.transfer(&mut (body.len() as u32).to_le_bytes(), true)?;
    transaction.transfer(&mut body, true)?;
    let mut size = [0; 4];
    transaction.transfer(&mut size, false)?;
    let size = u32::from_le_bytes(size) as usize;
    if size == 0 || size > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid reply length",
        ));
    }
    let mut reply = vec![0; size];
    transaction.transfer(&mut reply, false)?;
    let result = consume(serde_json::from_slice(&reply)?);
    transaction.transfer(&mut [1], true)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{mpsc, Arc};
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    fn server(serve: impl FnOnce(File) + Send + 'static) -> (u32, std::thread::JoinHandle<()>) {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        // Isolated names cannot collide with an actual host PID.
        let id = 0x8000_0000 + NEXT.fetch_add(1, Ordering::Relaxed) as u32;
        let name: Vec<u16> = format!(r"\\.\pipe\MaaEnd.CloudWeb.{id}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let (ready, started) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let pipe = unsafe {
                CreateNamedPipeW(
                    PCWSTR(name.as_ptr()),
                    PIPE_ACCESS_DUPLEX,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    1,
                    65536,
                    65536,
                    0,
                    None,
                )
            };
            assert!(!pipe.is_invalid());
            let mut pipe = unsafe { File::from_raw_handle(pipe.0) };
            ready.send(()).unwrap();
            if let Err(error) = unsafe { ConnectNamedPipe(HANDLE(pipe.as_raw_handle()), None) } {
                assert_eq!(
                    error.code(),
                    windows::Win32::Foundation::ERROR_PIPE_CONNECTED.to_hresult()
                );
            }
            let mut size = [0; 4];
            pipe.read_exact(&mut size).unwrap();
            let mut body = vec![0; u32::from_le_bytes(size) as usize];
            pipe.read_exact(&mut body).unwrap();
            serve(pipe);
        });
        started.recv().unwrap();
        (id, thread)
    }

    #[test]
    fn acknowledges_only_after_consumer_finishes_even_on_consumer_error() {
        let consumed = Arc::new(AtomicU64::new(0));
        let observed = Arc::clone(&consumed);
        let (id, thread) = server(move |mut pipe| {
            pipe.write_all(&2u32.to_le_bytes()).unwrap();
            pipe.write_all(b"{}").unwrap();
            let mut ack = [0];
            pipe.read_exact(&mut ack).unwrap();
            assert_eq!(ack, [1]);
            assert_eq!(observed.load(Ordering::Acquire), 1);
        });
        let cancellation = AtomicU64::new(0);
        let result: io::Result<()> = request(
            id,
            &serde_json::json!({"op":"frame_shared"}),
            &cancellation,
            0,
            |_| {
                consumed.store(1, Ordering::Release);
                Err(io::Error::other("consumer failed"))
            },
        );
        assert_eq!(result.unwrap_err().to_string(), "consumer failed");
        thread.join().unwrap();
    }

    #[test]
    fn partial_reply_has_a_total_deadline() {
        let (id, thread) = server(|mut pipe| {
            pipe.write_all(&[2, 0]).unwrap();
            let mut ack = [0];
            assert!(pipe.read_exact(&mut ack).is_err());
        });
        let started = Instant::now();
        let error = request(id, &serde_json::json!({}), &AtomicU64::new(0), 0, Ok).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(7));
        thread.join().unwrap();
    }

    #[test]
    fn cancellation_interrupts_pending_io() {
        let cancellation = Arc::new(AtomicU64::new(0));
        let cancel = Arc::clone(&cancellation);
        let (id, thread) = server(move |mut pipe| {
            cancel.fetch_add(1, Ordering::AcqRel);
            let mut ack = [0];
            assert!(pipe.read_exact(&mut ack).is_err());
        });
        let started = Instant::now();
        let error = request(id, &serde_json::json!({}), &cancellation, 0, Ok).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert!(started.elapsed() < Duration::from_secs(1));
        thread.join().unwrap();
    }

    #[test]
    fn rejects_oversized_replies_before_allocating() {
        let (id, thread) = server(|mut pipe| {
            pipe.write_all(&u32::MAX.to_le_bytes()).unwrap();
            let mut ack = [0];
            assert!(pipe.read_exact(&mut ack).is_err());
        });
        let error = request(id, &serde_json::json!({}), &AtomicU64::new(0), 0, Ok).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        thread.join().unwrap();
    }
}
