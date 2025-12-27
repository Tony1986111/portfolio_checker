use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("RPC调用失败: {0}")]
    RpcError(String),
    
    #[error("API请求失败: {0}")]
    ApiError(String),
    
    #[error("解析错误: {0}")]
    ParseError(String),
    
    #[error("数据库错误: {0}")]
    DbError(String),
}
