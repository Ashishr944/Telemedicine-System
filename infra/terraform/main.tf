data "aws_availability_zones" "available" {
  state = "available"
}
resource "aws_kms_key" "database" {
  description = "Amrutam ${var.environment} RDS encryption"
  enable_key_rotation = true
  deletion_window_in_days = 30
}
resource "aws_kms_alias" "database" {
  name = "alias/amrutam-${var.environment}-database"
  target_key_id = aws_kms_key.database.key_id
}
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.21.0"
  name = "amrutam-${var.environment}"
  cidr = var.vpc_cidr
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
  private_subnets = ["10.40.1.0/24", "10.40.2.0/24"]
  public_subnets = ["10.40.101.0/24", "10.40.102.0/24"]
  enable_nat_gateway = true
  single_nat_gateway = true
  enable_dns_hostnames = true
}
resource "aws_db_subnet_group" "main" {
  name = "amrutam-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}
resource "aws_security_group" "db" {
  name = "amrutam-${var.environment}-db"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "app" {
  name = "amrutam-${var.environment}-app"
  vpc_id = module.vpc.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_db_instance" "postgres" {
  identifier = "amrutam-${var.environment}"
  engine = "postgres"
  instance_class = "db.t4g.micro"
  allocated_storage = 20
  storage_encrypted = true
  db_name = "amrutam"
  username = "amrutam_app"
  manage_master_user_password = true
  master_user_secret_kms_key_id = aws_kms_key.database.arn
  kms_key_id = aws_kms_key.database.arn
  db_subnet_group_name = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible = false
  backup_retention_period = 7
  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "amrutam-${var.environment}-final"
}
