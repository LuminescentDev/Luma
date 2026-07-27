use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::embedded::Client;
use crate::errors::{LumaError, Result};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
struct Destination {
    host: String,
    port: u16,
}

async fn read_request<S>(stream: &mut S) -> std::io::Result<Destination>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut header = [0_u8; 2];
    stream.read_exact(&mut header).await?;
    if header[0] != 5 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsupported SOCKS version",
        ));
    }
    let methods_len = usize::from(header[1]);
    if methods_len == 0 || methods_len > 255 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid SOCKS methods",
        ));
    }
    let mut methods = vec![0_u8; methods_len];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 0xff]).await?;
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "SOCKS client does not support no-auth",
        ));
    }
    stream.write_all(&[5, 0]).await?;

    let mut request = [0_u8; 4];
    stream.read_exact(&mut request).await?;
    if request[0] != 5 || request[2] != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid SOCKS request",
        ));
    }
    if request[1] != 1 {
        write_reply(stream, 7).await?;
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "unsupported SOCKS command",
        ));
    }
    let host = match request[3] {
        1 => {
            let mut address = [0_u8; 4];
            stream.read_exact(&mut address).await?;
            Ipv4Addr::from(address).to_string()
        }
        4 => {
            let mut address = [0_u8; 16];
            stream.read_exact(&mut address).await?;
            Ipv6Addr::from(address).to_string()
        }
        3 => {
            let length = stream.read_u8().await?;
            if length == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "empty SOCKS domain",
                ));
            }
            let mut domain = vec![0_u8; usize::from(length)];
            stream.read_exact(&mut domain).await?;
            String::from_utf8(domain).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid SOCKS domain")
            })?
        }
        _ => {
            write_reply(stream, 8).await?;
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "unsupported SOCKS address type",
            ));
        }
    };
    let port = stream.read_u16().await?;
    if port == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "SOCKS destination port is zero",
        ));
    }
    Ok(Destination { host, port })
}

async fn write_reply<S>(stream: &mut S, code: u8) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

pub(crate) async fn serve(
    mut stream: tokio::net::TcpStream,
    handle: Arc<russh::client::Handle<Client>>,
) -> Result<()> {
    let destination = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_request(&mut stream))
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SOCKS handshake timed out".into(),
        })?
        .map_err(|error| LumaError::SshConnection {
            category: "invalid-input",
            message: format!("SOCKS handshake failed: {error}"),
        })?;
    let channel = match handle
        .channel_open_direct_tcpip(
            destination.host,
            u32::from(destination.port),
            "127.0.0.1",
            0,
        )
        .await
    {
        Ok(channel) => channel,
        Err(error) => {
            let _ = write_reply(&mut stream, 5).await;
            return Err(super::embedded::connect_error(error));
        }
    };
    write_reply(&mut stream, 0).await?;
    let mut channel = channel.into_stream();
    tokio::io::copy_bidirectional(&mut stream, &mut channel).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    async fn parse(bytes: &[u8]) -> (std::io::Result<Destination>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let input = bytes.to_vec();
        let task = tokio::spawn(async move {
            client.write_all(&input).await.unwrap();
            let mut reply = Vec::new();
            let _ = tokio::time::timeout(Duration::from_millis(50), client.read_to_end(&mut reply))
                .await;
            reply
        });
        let result = read_request(&mut server).await;
        drop(server);
        (result, task.await.unwrap())
    }

    #[tokio::test]
    async fn parses_ipv4_ipv6_and_domain_connect_requests() {
        let (ipv4, _) = parse(&[5, 1, 0, 5, 1, 0, 1, 1, 2, 3, 4, 0, 80]).await;
        assert_eq!(
            ipv4.unwrap(),
            Destination {
                host: "1.2.3.4".into(),
                port: 80
            }
        );

        let mut ipv6 = vec![5, 1, 0, 5, 1, 0, 4];
        ipv6.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        ipv6.extend_from_slice(&443_u16.to_be_bytes());
        assert_eq!(parse(&ipv6).await.0.unwrap().host, "::1");

        let mut domain = vec![5, 1, 0, 5, 1, 0, 3, 11];
        domain.extend_from_slice(b"example.com");
        domain.extend_from_slice(&22_u16.to_be_bytes());
        assert_eq!(
            parse(&domain).await.0.unwrap(),
            Destination {
                host: "example.com".into(),
                port: 22
            }
        );
    }

    #[tokio::test]
    async fn rejects_unsupported_method_command_and_address_type() {
        let (method, reply) = parse(&[5, 1, 2]).await;
        assert!(method.is_err());
        assert_eq!(reply, [5, 0xff]);

        let (command, reply) = parse(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]).await;
        assert!(command.is_err());
        assert!(reply.ends_with(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));

        let (address, reply) = parse(&[5, 1, 0, 5, 1, 0, 9]).await;
        assert!(address.is_err());
        assert!(reply.ends_with(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
    }
}
