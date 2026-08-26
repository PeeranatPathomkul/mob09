import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('products')
@Check('remaining_stock >= 0')
export class Product {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column('text')
  description: string;

  @Column('decimal', { precision: 10, scale: 2 })
  price: string;

  @Column({ name: 'total_stock', type: 'int' })
  totalStock: number;

  @Column({ name: 'remaining_stock', type: 'int' })
  remainingStock: number;

  @Column({ name: 'is_flash_sale_active', type: 'boolean', default: false })
  isFlashSaleActive: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
