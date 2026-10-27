// Windows 터미널: ConPTY를 직접 띄우고, 띄우는 순간부터 그 터미널의 Job Object 안에 둔다 (docs/windows-plan.md
// "세션 끝내기"). portable-pty의 ConPTY는 CreateProcessW에 Job을 줄 수 없어서 (띄운 뒤에 넣으면 그 사이 생긴 자식이 Job
// 밖에 남는다) 같은 일을 PROC_THREAD_ATTRIBUTE_JOB_LIST와 함께 한다. pty.rs가 쓰는 portable-pty의 MasterPty·Child를 구현해서
// 나머지 코드는 맥과 같다.
//
// - Job에는 KILL_ON_JOB_CLOSE를 건다. 핸들은 ddak만 쥔다 (자식에 물려주지 않음). ddak이 끝나면(비정상 종료 포함) OS가 Job
//   안을 모두 끝낸다.
// - 끝내기(pty.rs terminate)는 TerminateJobObject 뒤 ActiveProcesses가 0이 될 때까지 다시 조회한다 (반환이나 완료 포트
//   알림은 끝난 것의 판정에 쓰지 않는다).
// - Job 밖으로 빠지는 것(CREATE_BREAKAWAY_FROM_JOB)은 허락하지 않는다 (BREAKAWAY_OK를 켜지 않음).

use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize};
use std::fs::File;
use std::io::{Error as IoError, Result as IoResult};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    GetProcessId, INFINITE, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

fn last_error(what: &str) -> String {
    format!("{what}: {}", IoError::last_os_error())
}

fn owned(handle: HANDLE) -> OwnedHandle {
    unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }
}

// 터미널 하나의 Job. 닫히면 (Drop: 핸들을 닫음) 안의 프로세스가 모두 끝난다.
#[derive(Debug)]
pub struct Job(OwnedHandle);

impl Job {
    pub fn new() -> Result<Job, String> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(last_error("CreateJobObjectW"));
        }
        let job = Job(owned(handle));
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(last_error("SetInformationJobObject"));
        }
        Ok(job)
    }

    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle() as HANDLE
    }

    // Job 안의 프로세스를 모두 강제로 끝낸다. 끝난 것은 active()로 확인한다
    pub fn terminate(&self) {
        unsafe { TerminateJobObject(self.raw(), 1) };
    }

    // 아직 끝나지 않은 프로세스 수. 읽지 못하면 None (모르면 끝난 것으로 보지 않는다)
    pub fn active(&self) -> Option<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                self.raw(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(info.ActiveProcesses)
    }
}

// 의사 콘솔과 그 입출력 파이프 (ddak 쪽 끝)
struct Inner {
    con: HPCON,
    reader: File,
    writer: Option<File>,
    size: PtySize,
}

// HPCON은 콘솔 호스트를 가리키는 값일 뿐이라 스레드를 옮겨도 된다
unsafe impl Send for Inner {}

impl Drop for Inner {
    fn drop(&mut self) {
        // Windows 11 24H2 전에는 ClosePseudoConsole이 남은 출력이 다 읽힐 때까지 기다린다 (공식 문서). pty.rs의 읽기 스레드는
        // 화면 채널이 끊기면 읽기를 멈추므로 (리뷰 R4) 여기서 따로 끝까지 읽어 버린다. 콘솔 호스트가 닫히면 파이프가 끝나
        // 이 스레드도 끝난다.
        if let Ok(mut reader) = self.reader.try_clone() {
            std::thread::spawn(move || std::io::copy(&mut reader, &mut std::io::sink()));
        }
        unsafe { ClosePseudoConsole(self.con) };
    }
}

#[derive(Clone)]
pub struct Master(Arc<Mutex<Inner>>);

fn coord(size: &PtySize) -> COORD {
    COORD { X: size.cols as i16, Y: size.rows as i16 }
}

impl MasterPty for Master {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        let mut inner = self.0.lock().unwrap();
        let hr = unsafe { ResizePseudoConsole(inner.con, coord(&size)) };
        anyhow::ensure!(hr == 0, "ResizePseudoConsole: HRESULT {hr:#x}");
        inner.size = size;
        Ok(())
    }

    fn get_size(&self) -> anyhow::Result<PtySize> {
        Ok(self.0.lock().unwrap().size)
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        Ok(Box::new(self.0.lock().unwrap().reader.try_clone()?))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        let writer = self.0.lock().unwrap().writer.take().ok_or_else(|| anyhow::anyhow!("writer already taken"))?;
        Ok(Box::new(writer))
    }
}

// 띄운 프로세스 (셸)
#[derive(Debug)]
pub struct WinChild {
    process: OwnedHandle,
    pid: u32,
}

impl WinChild {
    fn raw(&self) -> HANDLE {
        self.process.as_raw_handle() as HANDLE
    }

    fn exit_code(&self) -> IoResult<ExitStatus> {
        let mut code = 0u32;
        if unsafe { GetExitCodeProcess(self.raw(), &mut code) } == 0 {
            return Err(IoError::last_os_error());
        }
        Ok(ExitStatus::with_exit_code(code))
    }
}

impl ChildKiller for WinChild {
    fn kill(&mut self) -> IoResult<()> {
        if unsafe { TerminateProcess(self.raw(), 1) } == 0 { Err(IoError::last_os_error()) } else { Ok(()) }
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        let process = self.process.try_clone().expect("DuplicateHandle");
        Box::new(WinChild { process, pid: self.pid })
    }
}

impl Child for WinChild {
    fn try_wait(&mut self) -> IoResult<Option<ExitStatus>> {
        if unsafe { WaitForSingleObject(self.raw(), 0) } == WAIT_OBJECT_0 { self.exit_code().map(Some) } else { Ok(None) }
    }

    fn wait(&mut self) -> IoResult<ExitStatus> {
        unsafe { WaitForSingleObject(self.raw(), INFINITE) };
        self.exit_code()
    }

    fn process_id(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn as_raw_handle(&self) -> Option<RawHandle> {
        Some(self.process.as_raw_handle())
    }
}

// 익명 파이프 (읽는 끝, 쓰는 끝)
fn pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    Ok((owned(read), owned(write)))
}

// argv를 Windows 명령 줄 한 줄로 (CommandLineToArgvW·MSVCRT 규칙. msys bash도 같은 규칙으로 나눈다)
pub fn command_line(argv: &[std::ffi::OsString]) -> Vec<u16> {
    let mut line: Vec<u16> = Vec::new();
    for (i, arg) in argv.iter().enumerate() {
        if i > 0 {
            line.push(' ' as u16);
        }
        let wide: Vec<u16> = arg.encode_wide().collect();
        let plain = !wide.is_empty() && !wide.iter().any(|&c| [' ', '\t', '\n', '\x0b', '"'].iter().any(|&q| c == q as u16));
        if plain {
            line.extend(&wide);
            continue;
        }
        line.push('"' as u16);
        let mut backslashes = 0;
        for &c in &wide {
            if c == '\\' as u16 {
                backslashes += 1;
                continue;
            }
            // 따옴표 앞의 역슬래시는 두 배로 하고 따옴표를 하나 더 막는다. 그 밖의 역슬래시는 그대로
            let n = if c == '"' as u16 { backslashes * 2 + 1 } else { backslashes };
            line.extend(std::iter::repeat_n('\\' as u16, n));
            line.push(c);
            backslashes = 0;
        }
        // 닫는 따옴표 앞의 역슬래시도 두 배로
        line.extend(std::iter::repeat_n('\\' as u16, backslashes * 2));
        line.push('"' as u16);
    }
    line.push(0);
    line
}

// 환경 블록: KEY=VALUE\0 … \0 (CREATE_UNICODE_ENVIRONMENT)
fn environment_block(cmd: &CommandBuilder) -> Vec<u16> {
    let mut block: Vec<u16> = Vec::new();
    for (key, value) in cmd.iter_full_env_as_str() {
        block.extend(key.encode_utf16());
        block.push('=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

// 속성 두 개(의사 콘솔, Job 목록)를 담은 목록
struct Attributes(Vec<u8>);

impl Attributes {
    fn new(count: u32) -> Result<Attributes, String> {
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut size) };
        let mut data = vec![0u8; size];
        if unsafe { InitializeProcThreadAttributeList(data.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST, count, 0, &mut size) } == 0 {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        Ok(Attributes(data))
    }

    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }

    // value는 CreateProcessW가 끝날 때까지 살아 있어야 한다
    fn set(&mut self, attribute: u32, value: *const std::ffi::c_void, size: usize) -> Result<(), String> {
        let ok = unsafe { UpdateProcThreadAttribute(self.ptr(), 0, attribute as usize, value, size, std::ptr::null_mut(), std::ptr::null()) };
        if ok == 0 { Err(last_error("UpdateProcThreadAttribute")) } else { Ok(()) }
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}

// 의사 콘솔을 만들고 cmd를 그 안에서, 처음부터 job 안에서 띄운다. 띄우지 못하면 아무것도 남지 않는다
// (만든 의사 콘솔·파이프는 Drop으로 닫힌다).
pub fn spawn(cmd: &CommandBuilder, size: PtySize, job: &Job) -> Result<(Master, WinChild), String> {
    let (in_read, in_write) = pipe()?;
    let (out_read, out_write) = pipe()?;
    let mut con: HPCON = 0;
    let hr = unsafe { CreatePseudoConsole(coord(&size), in_read.as_raw_handle() as HANDLE, out_write.as_raw_handle() as HANDLE, 0, &mut con) };
    if hr != 0 {
        return Err(format!("CreatePseudoConsole: HRESULT {hr:#x}"));
    }
    // 콘솔 호스트가 자기 사본을 가졌으므로 우리 쪽의 그 끝은 닫는다 (안 닫으면 출력이 끝나도 EOF가 오지 않는다)
    drop((in_read, out_write));
    let inner = Inner { con, reader: File::from(out_read), writer: Some(File::from(in_write)), size };

    let argv = cmd.get_argv();
    let program = argv.first().ok_or("empty command")?;
    // 절대 경로면 그것을, 아니면 CreateProcessW가 명령 줄의 첫 낱말을 찾게 둔다
    let mut application: Option<Vec<u16>> =
        std::path::Path::new(program).is_absolute().then(|| program.encode_wide().chain(std::iter::once(0)).collect());
    let mut line = command_line(argv);
    let mut env = environment_block(cmd);
    let cwd: Option<Vec<u16>> = cmd.get_cwd().map(|c| c.encode_wide().chain(std::iter::once(0)).collect());

    let mut attrs = Attributes::new(2)?;
    attrs.set(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, con as *const std::ffi::c_void, std::mem::size_of::<HPCON>())?;
    let jobs: [HANDLE; 1] = [job.raw()];
    attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs.as_ptr().cast(), std::mem::size_of_val(&jobs))?;

    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    // 부모의 표준 입출력을 물려받지 않게 (그러면 의사 콘솔 대신 거기로 쓴다)
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
    si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
    si.lpAttributeList = attrs.ptr();
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(
            application.as_mut().map_or(std::ptr::null(), |a| a.as_ptr()),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0, // 핸들을 물려주지 않는다 (Job 핸들은 ddak만)
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            env.as_mut_ptr().cast(),
            cwd.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            &si.StartupInfo,
            &mut pi,
        )
    };
    if ok == 0 {
        return Err(format!("{}: {}", program.to_string_lossy(), IoError::last_os_error()));
    }
    drop(owned(pi.hThread));
    let process = owned(pi.hProcess);
    let pid = unsafe { GetProcessId(process.as_raw_handle() as HANDLE) };
    Ok((Master(Arc::new(Mutex::new(inner))), WinChild { process, pid }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn line(args: &[&str]) -> String {
        let argv: Vec<OsString> = args.iter().map(OsString::from).collect();
        let wide = command_line(&argv);
        String::from_utf16(&wide[..wide.len() - 1]).unwrap()
    }

    #[test]
    fn quotes_like_msvcrt() {
        assert_eq!(line(&[r"C:\Program Files\Git\bin\bash.exe", "-l"]), r#""C:\Program Files\Git\bin\bash.exe" -l"#);
        assert_eq!(line(&["a", ""]), r#"a """#);
        assert_eq!(line(&["say \"hi\""]), r#""say \"hi\"""#);
        assert_eq!(line(&[r"dir\"]), r"dir\");
        assert_eq!(line(&[r"a dir\"]), r#""a dir\\""#);
        assert_eq!(line(&[r#"x\"y z"#]), r#""x\\\"y z""#);
    }

    // 셸이 끝내기 전에 띄운 자식(백그라운드 포함)도 Job 안이라 terminate로 끝나고, Job 수가 0이 된다
    #[test]
    fn job_holds_children() {
        let job = Job::new().unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/c", "start", "/b", "ping", "-n", "30", "127.0.0.1", "&", "ping", "-n", "30", "127.0.0.1"]);
        let (master, mut child) = spawn(&cmd, PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }, &job).unwrap();
        let mut reader = master.try_clone_reader().unwrap();
        std::thread::spawn(move || std::io::copy(&mut reader, &mut std::io::sink()));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while job.active().unwrap() < 3 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(job.active().unwrap() >= 3, "cmd와 ping 둘");
        job.terminate();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while job.active() != Some(0) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(job.active(), Some(0));
        // Job의 수가 먼저 줄고 프로세스 핸들은 그 뒤에 신호를 받는다 (pty.rs terminate는 그래서 wait로 기다린다)
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(child.try_wait().unwrap().is_some());
    }

    // 아무도 읽지 않아 출력이 파이프 용량을 넘은 채로 닫아도 멈추지 않는다 (리뷰 R4)
    #[test]
    fn closing_unread_console_returns() {
        let job = Job::new().unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/c", "for /l %i in (1,1,20000) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
        let (master, _child) = spawn(&cmd, PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }, &job).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let (done, closed) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drop(master);
            let _ = done.send(());
        });
        assert!(closed.recv_timeout(std::time::Duration::from_secs(10)).is_ok(), "ClosePseudoConsole이 돌아오지 않음");
        job.terminate();
    }

    #[test]
    fn exit_code_comes_back() {
        let job = Job::new().unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/c", "exit", "3"]);
        let (master, mut child) = spawn(&cmd, PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }, &job).unwrap();
        let mut reader = master.try_clone_reader().unwrap();
        std::thread::spawn(move || std::io::copy(&mut reader, &mut std::io::sink()));
        assert_eq!(child.wait().unwrap().exit_code(), 3);
    }
}
