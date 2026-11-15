use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/drocsid.rc");
    println!("cargo:rerun-if-changed=assets/drocsid.ico");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let rc_path = manifest_dir.join("src").join("drocsid.rc");
    let res_obj = out_dir.join("drocsid_res.o");

    if !rc_path.exists() {
        return;
    }

    let windres_candidates = [
        "windres",
        "x86_64-w64-mingw32-windres",
        r"C:\msys64\ucrt64\bin\windres.exe",
    ];

    for bin in windres_candidates {
        let status = Command::new(bin)
            .arg("-O")
            .arg("coff")
            .arg("-I")
            .arg(&manifest_dir)
            .arg("-i")
            .arg(&rc_path)
            .arg("-o")
            .arg(&res_obj)
            .status();

        if let Ok(st) = status {
            if st.success() && res_obj.exists() {
                println!("cargo:rustc-link-arg-bin=drocsid={}", res_obj.display());
                return;
            }
        }
    }

    println!(
        "cargo:warning=windres não encontrado; executável será compilado sem ícone/VERSIONINFO embutidos."
    );
}
