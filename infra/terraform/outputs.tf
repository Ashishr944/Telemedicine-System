output "database_address" {
  value = aws_db_instance.postgres.address
}
output "vpc_id" {
  value = module.vpc.vpc_id
}
output "database_secret_arn" {
  value = aws_db_instance.postgres.master_user_secret[0].secret_arn
}
